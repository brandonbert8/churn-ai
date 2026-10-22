import { z } from 'zod'

export const scopeSchema = z.object({
  customerId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  cutoff: z.iso.datetime({ offset: true }),
})
export type CaseScope = z.infer<typeof scopeSchema>

const evidence = z.object({
  id: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
  availableAt: z.iso.datetime({ offset: true }),
  source: z.string().min(1),
})
export const snapshotSchema = z.object({
  customerId: scopeSchema.shape.customerId,
  source: z.string().optional(),
  queryId: z.string().optional(),
  queryIds: z.record(z.string(), z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  availability: z.object({
    tickets: z.enum(['available', 'not_configured']),
    invoices: z.enum(['available', 'not_configured']),
    incidents: z.enum(['available', 'not_configured']),
    policies: z.enum(['available', 'not_configured']),
  }).optional(),
  tickets: z.array(evidence.extend({ text: z.string().max(10000) })).max(200),
  invoices: z.array(evidence.extend({
    serviceId: z.string(), period: z.string(), chargeCode: z.string(),
    amountMinor: z.number().int().nonnegative(), currency: z.literal('BOB'),
  })).max(500),
  incidents: z.array(evidence.extend({ summary: z.string(), resolved: z.boolean() })).max(200),
  policies: z.array(evidence.extend({
    action: z.enum(['BILLING_REVIEW', 'NETWORK_ESCALATION', 'REQUEST_DETAILS']),
    description: z.string(), expiresAt: z.iso.datetime({ offset: true }),
  })).max(30),
}).superRefine((snapshot, context) => {
  const ids = [...snapshot.tickets, ...snapshot.invoices, ...snapshot.incidents, ...snapshot.policies].map(row => row.id)
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Evidence IDs must be unique' })
})
export type Snapshot = z.infer<typeof snapshotSchema>
export type Action = Snapshot['policies'][number]['action']

export const plnSchema = z.object({
  category: z.string().min(1),
  scores: z.record(z.string(), z.number().min(0).max(1)),
  modelVersion: z.string().min(1),
  calibrated: z.boolean(),
  productionReady: z.boolean(),
  embedding: z.object({
    modelVersion: z.string(),
    dimensions: z.number().int().positive().max(4096),
    pooling: z.string(),
    semanticSearchValidated: z.boolean(),
    vector: z.array(z.number().finite()).max(4096),
  }).optional(),
}).superRefine((data, ctx) => {
  const scores = Object.values(data.scores)
  if (!scores.length || !Object.hasOwn(data.scores, data.category) || Math.abs(scores.reduce((a, b) => a + b, 0) - 1) > 0.01) {
    ctx.addIssue({ code: 'custom', message: 'Scores must sum to one and include category' })
  }
  if (data.embedding && data.embedding.vector.length !== data.embedding.dimensions) {
    ctx.addIssue({ code: 'custom', message: 'Embedding dimension mismatch' })
  }
})
