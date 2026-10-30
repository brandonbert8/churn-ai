import { accessAllowed } from '@/lib/retention-access'
import { DataSourceError } from '@/mastra/retention/service'
import { customerQuerySchema, listCustomers } from '@/mastra/retention/workspace'

export async function GET(request: Request) {
  if (!accessAllowed(request)) return Response.json({ error: 'Esta aplicación está disponible solo en localhost.' }, { status: 401 })
  const parsed = customerQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success) return Response.json({ error: 'Corte o búsqueda no válidos.' }, { status: 400 })
  try {
    return Response.json(await listCustomers(parsed.data.cutoff, parsed.data.query, parsed.data.offset), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return Response.json({ error: error instanceof DataSourceError ? error.message : 'No se pudo cargar la lista de clientes.' }, { status: error instanceof DataSourceError ? error.status : 502 })
  }
}
