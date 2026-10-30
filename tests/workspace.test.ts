import { z } from 'zod'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { conversationScopeSchema, listCustomers, RetentionWorkspace } from '../src/mastra/retention/workspace'
import { DEMO_CUTOFF } from '../src/mastra/retention/demo'
import { RequestContext } from '@mastra/core/request-context'
import { searchCustomers, openCustomerCase, getCustomerTimeline } from '../src/mastra/tools/retention-tools'
const originalMode = process.env.CHURN_DATA_MODE
afterEach(() => { if (originalMode === undefined) delete process.env.CHURN_DATA_MODE; else process.env.CHURN_DATA_MODE = originalMode })
test('conversation starts without customer or cutoff; invalid IDs remain rejected', () => {
  const parsed = conversationScopeSchema.parse({})
  assert.equal(parsed.customerId, undefined)
  assert.ok(Number.isFinite(Date.parse(parsed.cutoff)))
  assert.equal(conversationScopeSchema.safeParse({ customerId: '../other' }).success, false)
})
test('catalog filters prefixes and excludes tickets beyond cutoff', async () => {
  process.env.CHURN_DATA_MODE = 'demo'
  assert.deepEqual((await listCustomers(DEMO_CUTOFF, 'DEMO-002')).customers.map(c => c.customerId), ['DEMO-002'])
  assert.equal((await listCustomers('2000-01-01T00:00:00Z')).customers.length, 0)
})
test('general conversation opens cases through real tools, with isolated evidence per turn', async () => {
  process.env.CHURN_DATA_MODE = 'demo'
  const workspace = new RetentionWorkspace(DEMO_CUTOFF)
  await assert.rejects(workspace.current(), /Selecciona/)
  const requestContext = new RequestContext()
  requestContext.set('retentionWorkspace', workspace)
  const context = { requestContext, observe: { span: async <T>(_name: string, fn: () => T | Promise<T>) => fn(), log: () => {} } }
  const catalog = await searchCustomers.execute!({ query: '' }, context)
  assert.ok(z.object({ customers: z.array(z.object({ customerId: z.string() })) }).parse(catalog).customers.length > 0)
  const opened = await openCustomerCase.execute!({ customerId: 'DEMO-001' }, context)
  assert.equal(z.object({ customerId: z.string() }).parse(opened).customerId, 'DEMO-001')
  const timeline = await getCustomerTimeline.execute!({}, context)
  assert.ok(z.object({ tickets: z.array(z.object({ id: z.string() })) }).parse(timeline).tickets.every(t => t.id.startsWith('DEMO-001')))
  assert.throws(() => workspace.open('DEMO-002'), /un cliente por turno/)
})
test('UI selection remains locked against conversational changes', async () => {
  process.env.CHURN_DATA_MODE = 'demo'
  const workspace = new RetentionWorkspace(DEMO_CUTOFF, 'DEMO-001')
  assert.equal((await workspace.current()).scope.customerId, 'DEMO-001')
  assert.throws(() => workspace.open('DEMO-002'), /fijado/)
})

test('catalog pages demo results without duplicating the first page', async () => {
  process.env.CHURN_DATA_MODE = 'demo'
  const first = await listCustomers(DEMO_CUTOFF)
  assert.equal(first.total, 3)
  assert.equal(first.hasMore, false)
  const later = await listCustomers(DEMO_CUTOFF, '', 25)
  assert.equal(later.customers.length, 0)
  assert.equal(later.total, 3)
})
