import { z } from 'zod'
import { demoSnapshot } from './demo'
import { plnSchema, snapshotSchema, type Action, type CaseScope, type Snapshot } from './contracts'

export function dataMode() {
  const mode = process.env.CHURN_DATA_MODE ?? 'demo'
  if (mode !== 'demo' && mode !== 'live') throw new Error('CHURN_DATA_MODE inválido')
  return mode
}

/** Filter both event time and availability time to prevent future evidence leakage. */
export function atCutoff(snapshot: Snapshot, scope: CaseScope): Snapshot {
  if (snapshot.customerId !== scope.customerId) throw new Error('Caso fuera del alcance autorizado')
  const cutoff = Date.parse(scope.cutoff)
  const visible = (row: { occurredAt: string; availableAt: string }) =>
    Date.parse(row.occurredAt) <= cutoff && Date.parse(row.availableAt) <= cutoff
  return {
    customerId: scope.customerId,
    tickets: snapshot.tickets.filter(visible),
    invoices: snapshot.invoices.filter(visible),
    incidents: snapshot.incidents.filter(visible),
    policies: snapshot.policies.filter(p => visible(p) && Date.parse(p.expiresAt) > cutoff),
  }
}

export function compareCharges(snapshot: Snapshot) {
  const groups = new Map<string, Snapshot['invoices']>()
  for (const charge of snapshot.invoices) {
    const key = JSON.stringify([charge.serviceId, charge.period, charge.chargeCode, charge.amountMinor])
    groups.set(key, [...(groups.get(key) ?? []), charge])
  }
  const suspects = [...groups.values()].filter(rows => rows.length > 1)
  return {
    status: snapshot.invoices.length ? 'available' : 'missing' as const,
    charges: snapshot.invoices,
    duplicateCandidates: suspects.map(rows => ({
      evidenceIds: rows.map(r => r.id),
      period: rows[0].period,
      potentialExcessMinor: rows[0].amountMinor * (rows.length - 1),
      currency: 'BOB',
    })),
    limitation: 'Cargos coincidentes son indicios; confirmar legitimidad antes de corregir o devolver dinero.',
  }
}

export function allowedActions(snapshot: Snapshot) {
  const duplicate = compareCharges(snapshot).duplicateCandidates.length > 0
  const openIncident = snapshot.incidents.some(i => !i.resolved)
  const eligible: Action[] = ['REQUEST_DETAILS']
  if (duplicate) eligible.push('BILLING_REVIEW')
  if (openIncident) eligible.push('NETWORK_ESCALATION')
  return snapshot.policies.filter(p => eligible.includes(p.action)).map(p => ({
    action: p.action, policyId: p.id, description: p.description,
    requiresHumanReview: true,
    evidenceIds: p.action === 'BILLING_REVIEW'
      ? compareCharges(snapshot).duplicateCandidates.flatMap(c => c.evidenceIds)
      : p.action === 'NETWORK_ESCALATION'
        ? snapshot.incidents.filter(i => !i.resolved).map(i => i.id)
        : snapshot.tickets.map(t => t.id),
  }))
}

export class RetentionCase {
  private snapshot?: Promise<Snapshot>
  private calls = new Map<string, Promise<unknown>>()
  private used = 0
  private derivedEvidence = new Set<string>()
  constructor(readonly scope: CaseScope, private readonly fetcher: typeof fetch = fetch) {}

  /** Per-turn budget and deduplication also cover parallel tool calls. */
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const cached = this.calls.get(key)
    if (cached) return cached as Promise<T>
    if (this.used >= 6) return Promise.reject(new Error('Presupuesto de seis comprobaciones agotado; cerrar con evidencia parcial.'))
    this.used++
    const result = Promise.resolve().then(operation)
    this.calls.set(key, result)
    return result
  }

  private async request(path: string, body: unknown) {
    const base = process.env.CHURN_EVIDENCE_API_URL
    if (!base) throw new Error('Falta configurar el servicio autorizado de evidencia')
    const response = await this.fetcher(new URL(path, base.endsWith('/') ? base : `${base}/`), {
      method: 'POST', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CHURN_EVIDENCE_API_TOKEN ?? ''}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error('Servicio de evidencia no disponible')
    return response.json()
  }

  load(): Promise<Snapshot> {
    return this.snapshot ??= (async () => {
      const payload = dataMode() === 'demo'
        ? demoSnapshot(this.scope.customerId)
        : await this.request('case-snapshot', this.scope)
      if (!payload) throw new Error('Caso ficticio no encontrado; usa DEMO-001, DEMO-002 o DEMO-003')
      return atCutoff(snapshotSchema.parse(payload), this.scope)
    })()
  }

  async validEvidenceIds() {
    const snapshot = await this.load()
    return new Set([
      ...[...snapshot.tickets, ...snapshot.invoices, ...snapshot.incidents, ...snapshot.policies].map(item => item.id),
      ...this.derivedEvidence,
    ])
  }

  async analyze(ticketId: string) {
    const snapshot = await this.load()
    const ticket = snapshot.tickets.find(t => t.id === ticketId)
    if (!ticket) throw new Error('Ticket no disponible para este caso y corte')
    const url = process.env.PLN_API_URL
    if (!url) return { status: 'unavailable' as const, reason: 'Servicio PLN no configurado. No se simulan predicciones ni embeddings.', churnRisk: null }
    const response = await this.fetcher(url, {
      method: 'POST', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PLN_API_TOKEN ?? ''}` },
      body: JSON.stringify({ text: ticket.text, includeEmbedding: true }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error('Servicio PLN no disponible')
    const result = plnSchema.parse(await response.json())
    // The full vector is not useful in the LLM context. Validate it, expose provenance and shape.
    const { embedding, ...classification } = result
    const evidenceId = `${ticketId}:pln`
    this.derivedEvidence.add(evidenceId)
    return { status: 'available' as const, ticketId, evidenceId, ...classification, churnRisk: null,
      embedding: embedding ? {
        dimensions: embedding.dimensions, modelVersion: embedding.modelVersion,
        pooling: embedding.pooling, semanticSearchValidated: embedding.semanticSearchValidated,
      } : null,
      limitation: 'Categoría de reclamo; no equivale a sentimiento, intención de cancelar ni riesgo de abandono.',
    }
  }

  async risk() {
    // A tabular risk predictor is an independent, validated service, never an LLM guess.
    if (dataMode() === 'demo') return { status: 'unavailable', risk: null, reason: 'No hay predictor de churn validado en la demostración.' }
    const schema = z.object({ status: z.literal('available'), customerId: z.string(), cutoff: z.string(), risk: z.number().min(0).max(1), horizonDays: z.literal(90), calibrated: z.literal(true), modelVersion: z.string().min(1), evidenceIds: z.array(z.string()) })
    const result = schema.parse(await this.request('churn-score', this.scope))
    if (result.customerId !== this.scope.customerId || Date.parse(result.cutoff) !== Date.parse(this.scope.cutoff)) throw new Error('Score fuera del caso o corte solicitado')
    return result
  }
}
