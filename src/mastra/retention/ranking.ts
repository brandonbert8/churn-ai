import { z } from 'zod'
import { scopeSchema } from './contracts'
import { dataMode, evidenceRequest } from './service'

export const rankingOptionsSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
  metric: z.enum(['complaints', 'tickets']).default('complaints'),
  minTickets: z.number().int().min(1).max(1000000).default(1),
  lookbackDays: z.number().int().min(1).max(3650).nullable().default(null),
  activeOnly: z.boolean().default(true),
})
export type RankingOptions = z.infer<typeof rankingOptionsSchema>
export const customerRankingSchema = z.object({
  status: z.literal('available'), mode: z.literal('live'), cutoff: scopeSchema.shape.cutoff,
  periodStart: scopeSchema.shape.cutoff.nullable(), metric: z.enum(['complaints', 'tickets']),
  activeOnly: z.boolean(), minimumTickets: z.number().int().positive(), totalEligible: z.number().int().nonnegative(),
  customers: z.array(z.object({ customerId: scopeSchema.shape.customerId, customerName: z.string().nullable(),
    ticketCount: z.number().int().nonnegative(), complaintCount: z.number().int().nonnegative().nullable(),
    lastTicketAt: scopeSchema.shape.cutoff, alreadyChurned: z.boolean(), churnProbability: z.null(),
  })).max(50),
  queryId: z.string().min(1), sources: z.object({ tickets: z.string(), customers: z.string() }),
  sourceCoverage: z.object({ latestTicketAt: scopeSchema.shape.cutoff.nullable(), queryId: z.string().min(1) }),
  nameAvailability: z.enum(['available', 'not_configured']),
  probability: z.object({ status: z.literal('unavailable'), horizonDays: z.literal(90), reason: z.string() }),
  complaintDefinition: z.string(), warnings: z.array(z.string()),
})
export async function rankCustomers(cutoff: string, options: RankingOptions) {
  scopeSchema.shape.cutoff.parse(cutoff)
  const parsed = rankingOptionsSchema.parse(options)
  if (dataMode() === 'demo') return { status: 'unavailable' as const, mode: 'demo' as const,
    reason: 'El ranking agregado requiere Snowflake. No se simulan nombres ni probabilidades con los casos demo.' }
  const result = customerRankingSchema.parse(await evidenceRequest('customer-ranking', { cutoff, ...parsed }))
  if (Date.parse(result.cutoff) !== Date.parse(cutoff)) throw new Error('Ranking fuera del corte solicitado')
  if (result.metric !== parsed.metric || result.activeOnly !== parsed.activeOnly || result.minimumTickets !== parsed.minTickets || result.customers.length > parsed.limit) throw new Error('Ranking fuera de los filtros solicitados')
  if (parsed.activeOnly && result.customers.some(customer => customer.alreadyChurned)) throw new Error('El ranking de clientes activos incluye bajas confirmadas')
  return result
}
