import { rankCustomers, type RankingOptions } from './ranking'
import { z } from 'zod'
import { scopeSchema } from './contracts'
import { dataMode, evidenceRequest, RetentionCase } from './service'
import { demoSnapshot } from './demo'

export const conversationScopeSchema = z.object({
  customerId: scopeSchema.shape.customerId.optional(),
  cutoff: scopeSchema.shape.cutoff.default(() => new Date().toISOString()),
})
export const customerQuerySchema = z.object({ cutoff: scopeSchema.shape.cutoff, query: z.string().regex(/^[A-Za-z0-9_-]{0,80}$/).default(''), offset: z.coerce.number().int().min(0).max(1000000).default(0) })
export async function listCustomers(cutoff: string, query = '', offset = 0) {
  const params = customerQuerySchema.parse({ cutoff, query, offset })
  if (dataMode() === 'demo') {
    const customers = ['DEMO-001', 'DEMO-002', 'DEMO-003'].filter(id => id.startsWith(query)).map(customerId => ({
      customerId, ticketCount: demoSnapshot(customerId)!.tickets.filter(t => Date.parse(t.occurredAt) <= Date.parse(cutoff) && Date.parse(t.availableAt) <= Date.parse(cutoff)).length,
    })).filter(customer => customer.ticketCount > 0)
    return { mode: 'demo' as const, scope: 'customers_with_tickets' as const, offset, pageSize: 25, total: customers.length, hasMore: offset + 25 < customers.length, customers: customers.slice(offset, offset + 25) }
  }
  return z.object({ mode: z.literal('live'), source: z.string(), queryId: z.string(), scope: z.literal('customers_with_tickets'),
    offset: z.number().int().nonnegative(), pageSize: z.literal(25), total: z.number().int().nonnegative(), hasMore: z.boolean(),
    customers: z.array(z.object({ customerId: scopeSchema.shape.customerId, ticketCount: z.number().int().nonnegative(), lastTicketAt: z.string() })).max(25),
  }).parse(await evidenceRequest('customers', undefined, new URLSearchParams({ cutoff: params.cutoff, query: params.query, offset: String(params.offset) })))
}

/** Server-owned scope: the UI can lock a case; otherwise tools can open verified cases. */
export class RetentionWorkspace {
  private cases = new Map<string, RetentionCase>()
  private catalog = new Map<string, ReturnType<typeof listCustomers>>()
  private selection?: Promise<RetentionCase>
  private rankings = new Map<string, ReturnType<typeof rankCustomers>>()
  constructor(readonly cutoff: string, readonly lockedCustomerId?: string) {
    if (lockedCustomerId) this.selection = Promise.resolve(new RetentionCase({ customerId: lockedCustomerId, cutoff }))
  }
  list(query = '', offset = 0) {
    const key = JSON.stringify([query, offset])
    if (!this.catalog.has(key)) {
      if (this.catalog.size >= 3) throw new Error('Límite de búsquedas alcanzado para este turno')
      this.catalog.set(key, listCustomers(this.cutoff, query, offset))
    }
    return this.catalog.get(key)!
  }
  rank(options: RankingOptions) {
    const key = JSON.stringify(options)
    if (!this.rankings.has(key)) {
      if (this.rankings.size >= 2) throw new Error('Límite de dos rankings distintos por turno alcanzado')
      this.rankings.set(key, rankCustomers(this.cutoff, options))
    }
    return this.rankings.get(key)!
  }
  open(customerId: string) {
    scopeSchema.shape.customerId.parse(customerId)
    if (this.lockedCustomerId && customerId !== this.lockedCustomerId) throw new Error('El chat está fijado a otro cliente. Abre una conversación general para cambiarlo.')
    // One case per turn prevents parallel calls from mixing customer evidence.
    const selected = this.cases.keys().next().value
    if (selected && selected !== customerId) throw new Error('Investiga un cliente por turno para no mezclar evidencias.')
    const current = this.cases.get(customerId) ?? new RetentionCase({ customerId, cutoff: this.cutoff })
    this.cases.set(customerId, current)
    this.selection = (async () => { await current.load(); return current })()
    return this.selection
  }
  async current() {
    if (!this.selection) throw new Error('Selecciona un cliente con openCustomerCase antes de investigar')
    return this.selection
  }
}
