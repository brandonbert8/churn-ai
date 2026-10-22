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
        {error && <p role="alert" className="text-red-600">No se pudo completar la respuesta. Revisa la configuración y vuelve a enviar el mensaje.</p>}
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

export default function Chat() {
  const [customerId, setCustomerId] = useState('DEMO-001')
  const [cutoff, setCutoff] = useState('2026-10-20T23:59:00Z')
  const [token, setToken] = useState('')
  const [scope, setScope] = useState<Scope>({ customerId: 'DEMO-001', cutoff: '2026-10-20T23:59:00Z', token: '' })
  return <main className="flex h-screen flex-col max-w-6xl mx-auto">
    <header className="border-b p-6 space-y-3">
      <h1 className="text-2xl font-semibold">Investigador de retención · Tigo</h1>
      <p className="text-sm text-muted-foreground">DEMO-001: cargos coincidentes · DEMO-002: falla de red · DEMO-003: datos insuficientes. Son casos y políticas ficticios.</p>
      <form className="flex flex-wrap gap-3 items-end" onSubmit={event => { event.preventDefault(); setScope({ customerId, cutoff, token }) }}>
        <label className="text-sm">Cliente<input aria-label="Cliente" className="block border rounded p-2" value={customerId} onChange={e => setCustomerId(e.target.value)} required pattern="[A-Za-z0-9_-]{1,80}" /></label>
        <label className="text-sm">Corte temporal (ISO)<input aria-label="Corte temporal" className="block border rounded p-2" value={cutoff} onChange={e => setCutoff(e.target.value)} required /></label>
        <label className="text-sm">Acceso live (opcional)<input aria-label="Acceso live" type="password" autoComplete="off" className="block border rounded p-2" value={token} onChange={e => setToken(e.target.value)} /></label>
        <button className="border rounded px-4 py-2" type="submit">Abrir caso</button>
      </form>
      <p className="text-xs">Caso abierto: {scope.customerId} · {scope.cutoff}. No se ejecutan acciones comerciales.</p>
    </header>
    <CaseChat key={`${scope.customerId}:${scope.cutoff}:${scope.token}`} scope={scope} />
  </main>
}