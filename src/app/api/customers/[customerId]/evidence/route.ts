import { accessAllowed } from '@/lib/retention-access'
import { scopeSchema } from '@/mastra/retention/contracts'
import { dataMode, DataSourceError, RetentionCase } from '@/mastra/retention/service'

export async function GET(request: Request, { params }: { params: Promise<{ customerId: string }> }) {
  if (!accessAllowed(request)) return Response.json({ error: 'Disponible solo en localhost.' }, { status: 401 })
  const { customerId } = await params
  const parsed = scopeSchema.safeParse({ customerId, cutoff: new URL(request.url).searchParams.get('cutoff') })
  if (!parsed.success) return Response.json({ error: 'Cliente o corte inválidos.' }, { status: 400 })
  try {
    const snapshot = await new RetentionCase(parsed.data).load()
    return Response.json({
      mode: dataMode(), ...parsed.data, source: snapshot.source, queryIds: snapshot.queryIds,
      tickets: snapshot.tickets.map(row => ({ reference: row.id, sourceId: row.sourceId, column: row.sourceIdColumn, table: row.source })),
      invoices: snapshot.invoices.map(row => ({ reference: row.id, sourceId: row.sourceId, column: row.sourceIdColumn, table: row.source, period: row.period, amountMinor: row.amountMinor })),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return Response.json({ error: error instanceof DataSourceError ? error.message : 'No se pudieron cargar los registros originales del caso.' }, { status: error instanceof DataSourceError ? error.status : 502 })
  }
}
