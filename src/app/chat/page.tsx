'use client'

import '@/app/globals.css'
import { useEffect, useMemo, useState } from 'react'
import { DefaultChatTransport, ToolUIPart } from 'ai'
import { useChat } from '@ai-sdk/react'

import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input'

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'

import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'

import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from '@/components/ai-elements/tool'

type Scope = { customerId: string; cutoff: string; token: string }

function CaseChat({ scope }: { scope: Scope }) {
  const [input, setInput] = useState<string>('')

  const [loaded, setLoaded] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const transport = useMemo(() => new DefaultChatTransport({
    api: '/api/chat',
    body: { customerId: scope.customerId, cutoff: scope.cutoff },
    headers: scope.token ? { Authorization: `Bearer ${scope.token}` } : {},
  }), [scope])
  const { messages, setMessages, sendMessage, status, error, stop } = useChat({ transport })

  useEffect(() => {
    const controller = new AbortController()
    const query = new URLSearchParams({ customerId: scope.customerId, cutoff: scope.cutoff })
    fetch(`/api/chat?${query}`, {
      headers: scope.token ? { Authorization: `Bearer ${scope.token}` } : {},
      signal: controller.signal,
    }).then(async res => {
      if (!res.ok) throw new Error('No se pudo cargar el historial')
      const data = await res.json()
      if (!controller.signal.aborted) { setMessages(data); setLoaded(true) }
    }).catch(() => {
      if (!controller.signal.aborted) { setHistoryError(true); setLoaded(true) }
    })
    return () => controller.abort()
  }, [scope, setMessages])

  const handleSubmit = async () => {
    if (!input.trim() || !loaded || status === 'submitted' || status === 'streaming') return

    sendMessage({ text: input })
    setInput('')
  }

  return (
    <div className="relative flex-1 min-h-0 w-full p-6">
      <div className="flex h-full flex-col">
        {historyError && <p role="alert">No se pudo cargar el historial. Revisa el acceso o vuelve a abrir el caso.</p>}
        {error && <p role="alert" className="text-red-600">{responseError(error)}</p>}
        {(status === 'submitted' || status === 'streaming') && <p role="status" className="text-sm text-muted-foreground pb-2">Investigando el caso y contrastando evidencias… Las comprobaciones aparecen debajo.</p>}
        <Conversation className="h-full">
          <ConversationContent>
            {messages.length === 0 && <div className="rounded-xl border p-5 space-y-3">
              <h2 className="font-semibold">Investigar antes de proponer</h2>
              <p>El agente contrasta cargos, incidencias e historial. Las propuestas quedan pendientes de revisión.</p>
              <button type="button" className="underline" onClick={() => setInput('Investiga el reclamo de este cliente, contrasta las hipótesis y prepara una propuesta con referencias.')}>
                Investigar el caso seleccionado
              </button>
            </div>}
            {messages.map(message => (
              <div key={message.id}>
                {message.parts?.map((part, i) => {
                  if (part.type === 'text') {
                    return (
                      <Message key={`${message.id}-${i}`} from={message.role}>
                        <MessageContent>
                          <MessageResponse>{part.text}</MessageResponse>
                        </MessageContent>
                      </Message>
                    )
                  }

                  if (part.type?.startsWith('tool-')) {
                    return (
                      <Tool key={`${message.id}-${i}`}>
                        <ToolHeader
                          type={(part as ToolUIPart).type}
                          state={(part as ToolUIPart).state || 'output-available'}
                          className="cursor-pointer"
                        />
                        <ToolContent>
                          <ToolInput input={(part as ToolUIPart).input || {}} />
                          <ToolOutput
                            output={(part as ToolUIPart).output}
                            errorText={(part as ToolUIPart).errorText}
                          />
                        </ToolContent>
                      </Tool>
                    )
                  }

                  return null
                })}
              </div>
            ))}
            <ConversationScrollButton />
          </ConversationContent>
        </Conversation>

        <PromptInput onSubmit={handleSubmit} className="mt-4">
          <PromptInputBody>
            <PromptInputTextarea
              onChange={e => setInput(e.target.value)}
              className="md:leading-10"
              value={input}
              placeholder="Describe qué necesitas investigar del caso…"
              disabled={!loaded || status === 'submitted' || status === 'streaming'}
            />
            <button type="submit" className="m-3 rounded-lg bg-foreground px-4 py-2 text-background disabled:opacity-50" disabled={!loaded || !input.trim() || status === 'submitted' || status === 'streaming'}>Investigar</button>
            {(status === 'submitted' || status === 'streaming') && <button type="button" onClick={() => stop()}>Detener</button>}
          </PromptInputBody>
        </PromptInput>
      </div>
    </div>
  )
}

type Customer = { customerId: string; ticketCount: number }
type SourceState = {
  mode: 'demo' | 'live'; defaultCutoff: string; serviceAvailable: boolean
  pln: { modelDirectory: string; modelVersion: string; snowflake?: { configured: boolean; driverInstalled: boolean; missingVariables: string[]; table: string } } | null
}
function responseError(error: Error) {
  try { return JSON.parse(error.message).error ?? 'No se pudo completar la respuesta.' }
  catch { return 'No se pudo completar la respuesta. Revisa el servicio y el acceso.' }
}

export default function Chat() {
  const [customerId, setCustomerId] = useState('')
  const [cutoff, setCutoff] = useState('')
  const [token, setToken] = useState('')
  const [scope, setScope] = useState<Scope | null>(null)
  const [source, setSource] = useState<SourceState | null>(null)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/data-source', { signal: controller.signal }).then(res => {
      if (!res.ok) throw new Error('Configuración no disponible')
      return res.json()
    }).then((data: SourceState) => { setSource(data); setCutoff(data.defaultCutoff) }).catch(() => {
      if (!controller.signal.aborted) setCatalogError('No se pudo consultar la configuración del servicio.')
    })
    return () => controller.abort()
  }, [])

  const loadCustomers = async () => {
    setLoading(true); setCatalogError(''); setCustomers([])
    try {
      const query = new URLSearchParams({ cutoff, query: customerId })
      const response = await fetch(`/api/customers?${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'No se pudo consultar Snowflake.')
      setCustomers(data.customers)
      if (!data.customers.length) setCatalogError('No hay clientes con tickets para esa búsqueda y corte.')
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : 'No se pudo consultar Snowflake.')
    } finally { setLoading(false) }
  }
  return <main className="flex h-screen flex-col max-w-6xl mx-auto">
    <header className="border-b p-6 space-y-3">
      <h1 className="text-2xl font-semibold">Investigador de retención · Tigo</h1>
      <p className="text-sm text-muted-foreground">{source?.mode === 'demo'
        ? 'Modo de demostración seleccionado explícitamente: casos ficticios.'
        : `Fuente: Snowflake · ${source?.pln?.snowflake?.table ?? 'tickets del proyecto'}`}</p>
      {source?.pln && <p className="text-xs">PLN local: {source.pln.modelDirectory} · TF-IDF/LR y embeddings BETO.</p>}
      {source && !source.serviceAvailable && <p role="status">Inicia el servicio local de PLN y Snowflake para consultar los datos.</p>}
      {source?.mode === 'live' && source.pln?.snowflake && !source.pln.snowflake.configured && <p role="status">Conexión pendiente: configura {source.pln.snowflake.missingVariables.join(', ')} en el servidor.</p>}
      {source?.mode === 'live' && source.pln?.snowflake && !source.pln.snowflake.driverInstalled && <p role="status">Falta instalar el conector de Snowflake en el servicio local.</p>}
      <form className="flex flex-wrap gap-3 items-end" onSubmit={event => { event.preventDefault(); setScope({ customerId, cutoff, token }) }}>
        <label className="text-sm">Cliente o prefijo<input aria-label="Cliente" className="block border rounded p-2" value={customerId} onChange={e => setCustomerId(e.target.value)} required pattern="[A-Za-z0-9_-]{1,80}" placeholder="ID del cliente en Snowflake" /></label>
        <label className="text-sm">Corte temporal (ISO)<input aria-label="Corte temporal" className="block border rounded p-2" value={cutoff} onChange={e => setCutoff(e.target.value)} required /></label>
        {source?.mode !== 'demo' && <label className="text-sm">Acceso del asesor<input aria-label="Acceso live" type="password" autoComplete="off" className="block border rounded p-2" value={token} onChange={e => setToken(e.target.value)} /></label>}
        <button className="border rounded px-4 py-2" type="button" disabled={loading || !cutoff} onClick={loadCustomers}>{loading ? 'Consultando…' : 'Consultar clientes'}</button>
        <button className="border rounded px-4 py-2" type="submit" disabled={!customerId || !cutoff}>Abrir caso</button>
      </form>
      {catalogError && <p role="alert" className="text-red-600">{catalogError}</p>}
      {customers.length > 0 && <label className="block text-sm">Clientes con tickets hasta el corte
        <select aria-label="Clientes de Snowflake" className="border rounded p-2 mx-2" value="" onChange={event => { if (event.target.value) { setCustomerId(event.target.value); setScope({ customerId: event.target.value, cutoff, token }) } }}>
          <option value="">Seleccionar cliente…</option>
          {customers.map(customer => <option key={customer.customerId} value={customer.customerId}>{customer.customerId} · {customer.ticketCount} tickets</option>)}
        </select>
      </label>}
      {scope && <p className="text-xs">Caso abierto: {scope.customerId} · {scope.cutoff}. No se ejecutan acciones comerciales.</p>}
    </header>
    {scope ? <CaseChat key={`${scope.customerId}:${scope.cutoff}:${scope.token}`} scope={scope} /> : <section className="p-6"><h2 className="font-semibold">Selecciona un cliente del proyecto</h2><p>Consulta clientes en Snowflake o introduce su ID para revisar sus tickets con el modelo PLN local.</p></section>}
  </main>
}
