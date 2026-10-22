import { z } from 'zod'
import { accessAllowed } from '@/lib/retention-access'
import { dataMode, DataSourceError, evidenceRequest } from '@/mastra/retention/service'
import { demoSnapshot } from '@/mastra/retention/demo'

const querySchema = z.object({ cutoff: z.iso.datetime({ offset: true }), query: z.string().regex(/^[A-Za-z0-9_-]{0,80}$/).default('') })
export async function GET(request: Request) {
  if (!accessAllowed(request)) return Response.json({ error: 'Introduce el acceso configurado en CHURN_APP_TOKEN.' }, { status: 401 })
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success) return Response.json({ error: 'Corte o búsqueda no válidos.' }, { status: 400 })
  if (dataMode() === 'demo') return Response.json({ mode: 'demo', customers: ['DEMO-001', 'DEMO-002', 'DEMO-003'].map(customerId => ({ customerId, ticketCount: demoSnapshot(customerId)!.tickets.length })) })
  try {
    const result = await evidenceRequest('customers', undefined, new URLSearchParams(parsed.data))
    const schema = z.object({ mode: z.literal('live'), source: z.string(), queryId: z.string(), customers: z.array(z.object({ customerId: z.string(), ticketCount: z.number().int().nonnegative(), lastTicketAt: z.string() })).max(25) })
    return Response.json(schema.parse(result), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return Response.json({ error: error instanceof DataSourceError ? error.message : 'No se pudo consultar el catálogo de clientes en Snowflake.' }, { status: error instanceof DataSourceError ? error.status : 502 })
  }
}
