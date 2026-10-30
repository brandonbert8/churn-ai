import { handleChatStream } from '@mastra/ai-sdk'
import { toAISdkMessages } from '@mastra/ai-sdk/ui'
import { RequestContext } from '@mastra/core/request-context'
import { createUIMessageStreamResponse } from 'ai'
import { cookies } from 'next/headers'
import { accessAllowed } from '@/lib/retention-access'
import { z } from 'zod'
import { mastra } from '@/mastra'
import { conversationScopeSchema, RetentionWorkspace } from '@/mastra/retention/workspace'
import { dataMode, DataSourceError } from '@/mastra/retention/service'

const bodySchema = z.object({
  ...conversationScopeSchema.shape,
  messages: z.array(z.object({
    id: z.string().min(1).max(100), role: z.enum(['user', 'assistant']),
    parts: z.array(z.unknown()).max(100),
  })).min(1).max(100),
})
const textSchema = z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(10000) })

async function session() {
  const store = await cookies()
  let id = store.get('retention-session')?.value
  if (!id || !z.uuid().safeParse(id).success) {
    id = crypto.randomUUID()
    store.set('retention-session', id, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 86400 })
  }
  return id
}
function memoryScope(id: string, scope: z.infer<typeof conversationScopeSchema>) {
  return { resource: id, thread: `${id}:${dataMode()}:${scope.customerId ?? 'general'}:${new Date(scope.cutoff).toISOString()}` }
}

export async function POST(request: Request) {
  if (!accessAllowed(request)) return Response.json({ error: 'Esta aplicación está disponible solo en localhost.' }, { status: 401 })
  if (!process.env.OPENROUTER_API_KEY) return Response.json({ error: 'Falta OPENROUTER_API_KEY en el servidor.' }, { status: 503 })
  try {
    const parsed = bodySchema.safeParse(await request.json())
    if (!parsed.success) return Response.json({ error: 'Escribe un mensaje válido.' }, { status: 400 })
    const { customerId, cutoff, messages } = parsed.data
    // Only the last user text is accepted. History/tool results come from server memory.
    const latest = messages.at(-1)
    if (latest?.role !== 'user') return Response.json({ error: 'Se requiere un mensaje del asesor.' }, { status: 400 })
    const parts = latest.parts.map(part => textSchema.parse(part))
    if (!parts.length) return Response.json({ error: 'Mensaje vacío.' }, { status: 400 })
    const scope = { customerId, cutoff }
    const workspace = new RetentionWorkspace(cutoff, customerId)
    const requestContext = new RequestContext()
    requestContext.set('retentionWorkspace', workspace)
    const stream = await handleChatStream({
      mastra, agentId: 'retention-agent', version: 'v7', sendReasoning: false,
      params: {
        messages: [{ id: latest.id, role: 'user', parts }],
        memory: memoryScope(await session(), scope),
        requestContext, maxSteps: 8, abortSignal: request.signal,
      },
      onError: () => 'No se pudo completar la investigación. Revisa la conexión e inténtalo de nuevo.',
    })
    return createUIMessageStreamResponse({ stream, headers: { 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' } })
  } catch (error) {
    if (error instanceof DataSourceError) return Response.json({ error: error.message }, { status: error.status })
    const invalid = error instanceof z.ZodError || error instanceof SyntaxError
    return Response.json({ error: invalid ? 'Solicitud o datos del servicio con formato inválido.' : 'No se pudo abrir el caso o conectar con el proveedor. Revisa la configuración.' }, { status: invalid ? 400 : 502 })
  }
}

export async function GET(request: Request) {
  if (!accessAllowed(request)) return Response.json({ error: 'Esta aplicación está disponible solo en localhost.' }, { status: 401 })
  const query = Object.fromEntries(new URL(request.url).searchParams)
  const parsed = conversationScopeSchema.safeParse(query)
  if (!parsed.success) return Response.json({ error: 'Contexto de conversación inválido.' }, { status: 400 })
  const scope = memoryScope(await session(), parsed.data)
  const memory = await mastra.getAgentById('retention-agent').getMemory()
  const existing = await memory?.getThreadById({ threadId: scope.thread })
  if (!existing) return Response.json([], { headers: { 'Cache-Control': 'no-store' } })
  const response = await memory?.recall({ threadId: scope.thread, resourceId: scope.resource })
  return Response.json(toAISdkMessages(response?.messages ?? [], { version: 'v7' }), { headers: { 'Cache-Control': 'no-store' } })
}
