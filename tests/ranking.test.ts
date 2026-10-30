import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { customerRankingSchema, rankingOptionsSchema, rankCustomers } from '../src/mastra/retention/ranking'
import { RetentionWorkspace } from '../src/mastra/retention/workspace'
import { RequestContext } from '@mastra/core/request-context'
import { rankCustomersByComplaints } from '../src/mastra/tools/retention-tools'
const originalMode = process.env.CHURN_DATA_MODE
afterEach(() => { if (originalMode === undefined) delete process.env.CHURN_DATA_MODE; else process.env.CHURN_DATA_MODE = originalMode })
test('ranking defaults target complaints and active customers without silently truncating the period', () => {
  const options = rankingOptionsSchema.parse({})
  assert.deepEqual(options, { limit: 10, metric: 'complaints', minTickets: 1, lookbackDays: null, activeOnly: true })
  assert.equal(rankingOptionsSchema.safeParse({ limit: 51 }).success, false)
  assert.equal(rankingOptionsSchema.safeParse({ lookbackDays: -1 }).success, false)
})
test('demo ranking does not fabricate names or probabilities and works without opening a case', async () => {
  process.env.CHURN_DATA_MODE = 'demo'
  const options = rankingOptionsSchema.parse({})
  const result = await rankCustomers('2026-10-22T00:00:00Z', options)
  assert.equal(result.status, 'unavailable')
  const requestContext = new RequestContext()
  requestContext.set('retentionWorkspace', new RetentionWorkspace('2026-10-22T00:00:00Z'))
  const context = { requestContext, observe: { span: async <T>(_name: string, fn: () => T | Promise<T>) => fn(), log: () => {} } }
  const output = await rankCustomersByComplaints.execute!(options, context)
  assert.ok(output && typeof output === 'object' && 'status' in output && output.status === 'unavailable')
})
test('gateway contract refuses invented numeric probabilities in a source without a risk model', () => {
  const output = { status: 'available', mode: 'live', cutoff: '2026-10-22T00:00:00Z', periodStart: null, metric: 'complaints', activeOnly: true, minimumTickets: 1, totalEligible: 1,
    customers: [{ customerId: 'CLI-001', customerName: null, ticketCount: 8, complaintCount: 5, lastTicketAt: '2024-12-01T00:00:00Z', alreadyChurned: false, churnProbability: null }],
    queryId: 'query-test', sources: { tickets: 'DBT.BRONCE.STG_SOPORTE_TICKETS', customers: 'DBT.ORO.DIM_CLIENTES' }, sourceCoverage: { latestTicketAt: '2024-12-01T00:00:00Z', queryId: 'coverage-test' },
    nameAvailability: 'not_configured', probability: { status: 'unavailable', horizonDays: 90, reason: 'No hay modelo' }, complaintDefinition: 'CATEGORIA reclamacion', warnings: [], }
  assert.equal(customerRankingSchema.safeParse(output).success, true)
  assert.equal(customerRankingSchema.safeParse({ ...output, customers: [{ ...output.customers[0], churnProbability: 0.9 }] }).success, false)
})
