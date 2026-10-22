import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { RequestContext } from '@mastra/core/request-context'
import { demoSnapshot, DEMO_CUTOFF } from '../src/mastra/retention/demo'
import { atCutoff, allowedActions, compareCharges, RetentionCase } from '../src/mastra/retention/service'
import { plnSchema } from '../src/mastra/retention/contracts'
import { activeCase, draftResolutionPlan } from '../src/mastra/tools/retention-tools'

const originalEnv = { ...process.env }
afterEach(() => { process.env = { ...originalEnv } })
const scope = { customerId: 'DEMO-001', cutoff: DEMO_CUTOFF }

test('billing evidence is a candidate for review; amounts use integer cents', () => {
  const snapshot = demoSnapshot('DEMO-001')!
  assert.equal(compareCharges(snapshot).duplicateCandidates[0].potentialExcessMinor, 15000)
  assert.deepEqual(allowedActions(snapshot).map(a => a.action), ['BILLING_REVIEW', 'REQUEST_DETAILS'])
  assert.equal(allowedActions(demoSnapshot('DEMO-002')!).some(a => a.action === 'BILLING_REVIEW'), false)
  assert.equal(allowedActions(demoSnapshot('DEMO-003')!).length, 1)
})

test('future events, late evidence and expired policies cannot inform the case', () => {
  const snapshot = demoSnapshot('DEMO-001')!
  snapshot.tickets.push({ ...snapshot.tickets[0], id: 'future', occurredAt: '2026-10-22T00:00:00Z' })
  snapshot.invoices[1].availableAt = '2026-10-22T00:00:00Z'
  snapshot.policies[0].expiresAt = '2026-10-19T00:00:00Z'
  const filtered = atCutoff(snapshot, scope)
  assert.equal(filtered.tickets.length, 1)
  assert.equal(compareCharges(filtered).duplicateCandidates.length, 0)
  assert.equal(allowedActions(filtered).some(a => a.action === 'BILLING_REVIEW'), false)
  assert.throws(() => atCutoff(snapshot, { ...scope, customerId: 'another-customer' }))
})

test('parallel duplicate tools run once and budget holds for concurrent calls', async () => {
  const current = new RetentionCase(scope)
  let executions = 0
  const operation = async () => ++executions
  await Promise.all([current.run('same', operation), current.run('same', operation)])
  assert.equal(executions, 1)
  await Promise.all(Array.from({ length: 5 }, (_, i) => current.run(`other-${i}`, operation)))
  await assert.rejects(current.run('seventh', operation), /agotado/)
  assert.equal(executions, 6)
})

test('missing PLN and churn predictors produce no fabricated predictions', async () => {
  process.env.CHURN_DATA_MODE = 'demo'
  delete process.env.PLN_API_URL
  const current = new RetentionCase(scope)
  assert.equal((await current.analyze('DEMO-001-T1')).status, 'unavailable')
  assert.equal((await current.risk()).risk, null)
  await assert.rejects(current.analyze('OTHER-T1'), /no disponible/)
})

test('PLN vectors have validated dimensions and never populate the language model context', async () => {
  process.env.CHURN_DATA_MODE = 'demo'
  process.env.PLN_API_URL = 'https://pln.example.invalid/analyze'
  const result = {
    category: 'FACTURACION', scores: { FACTURACION: 0.7, RED: 0.3 },
    modelVersion: 'test-v1', calibrated: false, productionReady: false,
    embedding: { modelVersion: 'beto-test', dimensions: 3, pooling: 'mean', semanticSearchValidated: false, vector: [0.1, 0.2, 0.3] },
  }
  assert.equal(plnSchema.safeParse({ ...result, embedding: { ...result.embedding, dimensions: 768 } }).success, false)
  assert.equal(plnSchema.safeParse({ ...result, scores: { FACTURACION: 0.9 } }).success, false)
  const fetcher: typeof fetch = async () => Response.json(result)
  const analyzed = await new RetentionCase(scope, fetcher).analyze('DEMO-001-T1')
  assert.equal(analyzed.status, 'available')
  if (analyzed.status !== 'available') throw new Error('Expected PLN result')
  assert.equal(analyzed.embedding?.dimensions, 3)
  assert.equal('vector' in (analyzed.embedding ?? {}), false)
})

test('tools require a server scope and plans reject ineligible actions or invented references', async () => {
  assert.throws(() => activeCase(), /Selecciona/)
  process.env.CHURN_DATA_MODE = 'demo'
  const requestContext = new RequestContext()
  requestContext.set('retentionCase', new RetentionCase(scope))
  const context = { requestContext, observe: { span: async <T>(_name: string, fn: () => T | Promise<T>) => fn(), log: () => {} } }
  const hypotheses = [{ description: 'Cargos coincidentes', status: 'supported' as const, evidenceIds: ['DEMO-001-C1', 'DEMO-001-C2'] }]
  // Call the real execution handler; tool schemas are checked separately by Mastra.
  const execute = draftResolutionPlan.execute!
  const plan = await execute({ action: 'BILLING_REVIEW', hypotheses }, context)
  assert.ok(plan && typeof plan === 'object' && 'executed' in plan && 'status' in plan)
  assert.equal(plan.executed, false)
  assert.equal(plan.status, 'pending-human-review')
  await assert.rejects(Promise.resolve().then(() => execute({ action: 'NETWORK_ESCALATION', hypotheses }, context)), /no elegible/)
  const correction = await execute({ action: 'BILLING_REVIEW', hypotheses: [{ ...hypotheses[0], evidenceIds: ['invented'] }] }, context)
  assert.ok(correction && typeof correction === 'object' && 'status' in correction && 'executed' in correction)
  assert.equal(correction.status, 'needs-correction')
  assert.equal(correction.executed, false)
})

test('live gateway rejects another customer instead of falling back to demo', async () => {
  process.env.CHURN_DATA_MODE = 'live'
  process.env.CHURN_EVIDENCE_API_URL = 'https://evidence.example.invalid/'
  const fetcher: typeof fetch = async () => Response.json(demoSnapshot('DEMO-002'))
  await assert.rejects(new RetentionCase(scope, fetcher).load(), /fuera del alcance/)
})
