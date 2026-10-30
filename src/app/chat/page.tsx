'use client'

import './chat.css'
import { CustomerEvidence } from '@/components/customer-evidence'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DefaultChatTransport, type ToolUIPart } from 'ai'
import { useChat } from '@ai-sdk/react'
import { 
  ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronRight, CircleHelp, 
  LoaderCircle, MessageSquare, PanelLeftOpen, Plus, Search, ShieldCheck, 
  Sparkles, Square, Users, X, Wrench 
} from 'lucide-react'
import { MessageResponse } from '@/components/ai-elements/message'

// --- Tipos ---
type Customer = { 
  customerId: string; 
  ticketCount: number 
}

type Source = { 
  mode: 'demo' | 'live'; 
  defaultCutoff: string; 
  serviceAvailable: boolean 
}

type Scope = { 
  customerId?: string; 
  cutoff: string 
}

// --- Constantes ---
const suggestions = [
  { 
    icon: Users, 
    title: 'Clientes con más reclamos', 
    detail: 'Prioriza qué casos revisar', 
    prompt: 'Muéstrame el nombre e ID de los 10 clientes activos con más tickets de reclamos, sus conteos y probabilidades de abandono si están disponibles.' 
  },
  { 
    icon: MessageSquare, 
    title: 'Entender un reclamo', 
    detail: 'Conecta los hechos del caso', 
    prompt: 'Quiero entender un reclamo. Busca clientes y ayúdame a seleccionar un caso.' 
  },
  { 
    icon: ShieldCheck, 
    title: 'Preparar una propuesta', 
    detail: 'Resuelve con evidencia', 
    prompt: 'Ayúdame a preparar una propuesta de atención con evidencia. ¿Qué casos podemos revisar?' 
  },
]

const toolNames: Record<string, string> = { 
  rankCustomersByComplaints: 'Priorizando clientes por reclamos', 
  searchCustomers: 'Buscando clientes', 
  openCustomerCase: 'Abriendo el caso', 
  getCustomerTimeline: 'Revisando historial', 
  compareInvoices: 'Comparando facturas', 
  checkServiceIncidents: 'Consultando incidencias', 
  analyzeTicket: '(PLN) para Analizar el reclamo', 
  scoreChurn90d: 'Consultando riesgo de abandono', 
  evaluateAllowedActions: 'Revisando opciones de atención', 
  draftResolutionPlan: 'Preparando propuesta' 
}

const toolDescriptions: Record<string, string> = {
  rankCustomersByComplaints: 'Ordena clientes de la cartera por volumen de reclamos o tickets.', 
  searchCustomers: 'Busca clientes en el catálogo usando un prefijo de ID.',
  openCustomerCase: 'Abre el caso del cliente para consultar sus datos autorizados.', 
  getCustomerTimeline: 'Revisa los tickets y eventos del cliente hasta la fecha de corte.',
  compareInvoices: 'Busca cargos coincidentes que podrían requerir revisión.', 
  checkServiceIncidents: 'Consulta incidencias técnicas asociadas al servicio.',
  analyzeTicket: 'Envía el texto del reclamo al clasificador PLN para identificar su categoría.', 
  scoreChurn90d: 'Consulta el predictor disponible de riesgo de abandono a 90 días.',
  evaluateAllowedActions: 'Revisa qué opciones permiten las políticas y evidencias disponibles.', 
  draftResolutionPlan: 'Prepara una propuesta documentada para revisión humana.',
}

// --- Utilidades ---
function friendlyError(error: Error) { 
  try { 
    return JSON.parse(error.message).error ?? 'No se pudo completar la respuesta.' 
  } catch { 
    return 'No se pudo conectar con el agente. Inténtalo de nuevo.' 
  } 
}

// --- Componentes ---
function ToolActivity({ part, onPlnText }: { part: ToolUIPart; onPlnText: (text: string) => void }) {
  const name = part.type.replace(/^tool-/, '')
  const done = part.state === 'output-available'
  const output = 'output' in part ? part.output : undefined
  const unavailable = !!output && typeof output === 'object' && 'status' in output && output.status === 'unavailable'
  const failed = part.state === 'output-error' || part.state === 'output-denied' || unavailable
  const needsText = !!output && typeof output === 'object' && 'status' in output && output.status === 'needs_text'
  
  return (
    <details className={`agent-tool ${(!done && !failed && !needsText) ? 'is-running' : ''}`} open={needsText}>
      <summary>
        {failed ? (
          <CircleHelp size={14} />
        ) : done ? (
          <Check size={14} />
        ) : (
          <LoaderCircle size={14} className="animate-spin" />
        )}
        
        <span>
          {needsText 
            ? 'El agente quiere analizar este reclamo con PLN' 
            : !done && !failed 
              ? `Usando Herramienta: ${toolNames[name] ?? name}` 
              : toolNames[name] ?? name}
        </span>
        
        <small>
          {needsText ? 'Falta el texto' : failed ? 'No disponible' : done ? 'Completado' : 'En curso'}
        </small>
        <ChevronRight size={13} />
      </summary>

      {needsText ? (
        <>
          <p className="tool-description">{toolDescriptions[name]}</p>
          <PlnTextRequest onSubmit={onPlnText} />
        </>
      ) : (
        <div className="tool-details">
          <p>{toolDescriptions[name] ?? 'Herramienta del agente para consultar información.'}</p>
          <pre>
            {JSON.stringify(part.state === 'output-error' ? part.errorText : ('output' in part ? part.output : part.input), null, 2)}
          </pre>
        </div>
      )}
    </details>
  )
}

function PlnTextRequest({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [text, setText] = useState('')
  
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (text.trim()) onSubmit(text.trim())
  }

  return (
    <form className="pln-request" onSubmit={handleSubmit}>
      <label>Pega el texto del reclamo para continuar</label>
      <textarea 
        value={text} 
        maxLength={10000} 
        rows={3} 
        placeholder="Pega aquí el texto que quieres clasificar…" 
        onChange={event => setText(event.target.value)} 
      />
      <button type="submit" disabled={!text.trim()}>
        Analizar con PLN
      </button>
      <small>El PLN clasifica el reclamo; no calcula probabilidad de abandono.</small>
    </form>
  )
}

function AgentChat({ scope, customer }: { scope: Scope; customer?: Customer }) {
  const [input, setInput] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const [showLatest, setShowLatest] = useState(false)
  
  const bottom = useRef<HTMLDivElement>(null)
  const followResponse = useRef(true)
  
  const transport = useMemo(() => new DefaultChatTransport({ 
    api: '/api/chat', 
    body: { customerId: scope.customerId, cutoff: scope.cutoff } 
  }), [scope])
  
  const { messages, setMessages, sendMessage, status, error, stop, regenerate } = useChat({ 
    transport, 
    throttle: 32 
  })
  
  const busy = status === 'submitted' || status === 'streaming'

  useEffect(() => {
    const controller = new AbortController()
    
    const loadChatHistory = async () => {
      const query = new URLSearchParams({ 
        cutoff: scope.cutoff, 
        ...(scope.customerId ? { customerId: scope.customerId } : {}) 
      })
      
      try {
        const response = await fetch(`/api/chat?${query}`, { signal: controller.signal })
        if (!response.ok) throw new Error()
        const data = await response.json()
        
        if (!controller.signal.aborted) {
          setMessages(data)
          setLoaded(true)
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setHistoryError(true)
          setLoaded(true)
        }
      }
    }
    
    loadChatHistory()
    return () => controller.abort()
  }, [scope, setMessages])

  useEffect(() => { 
    if (followResponse.current) {
      bottom.current?.scrollIntoView({ behavior: busy ? 'instant' : 'smooth', block: 'end' }) 
    }
  }, [messages, busy])

  const submitPlnText = (text: string) => { 
    if (busy || !loaded) return
    followResponse.current = true
    const request = `Continúa el análisis PLN solicitado usando pastedText exactamente igual a este texto: ${text}`
    void sendMessage({ text: request }) 
  }

  const submit = (text = input) => { 
    if (!text.trim() || busy || !loaded) return
    followResponse.current = true
    setShowLatest(false)
    void sendMessage({ text: text.trim() })
    setInput('') 
  }

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120
    followResponse.current = nearBottom
    setShowLatest(!nearBottom)
  }

  return (
    <div className="chat-workspace">
      <div className="chat-scroll" onScroll={handleScroll}>
        {messages.length === 0 ? (
          <section className="chat-welcome">
            <div className="welcome-eyebrow">
              <span /> TU ESPACIO DE ANÁLISIS
            </div>
            <div className="welcome-mark">
              <Sparkles size={29} strokeWidth={1.5} />
            </div>
            
            <h1>
              {customer ? (
                <>Cada cliente tiene<br /><span>una historia.</span></>
              ) : (
                <>Una buena conversación.<br /><span>Una mejor decisión.</span></>
              )}
            </h1>
            
            <p>
              {customer 
                ? <>Exploremos el caso de <strong>{customer.customerId}</strong>. Pregúntame por sus reclamos, su historial o cómo podemos ayudarle.</> 
                : 'Pregunta, explora y conecta los datos de tus clientes. Tu agente busca la información y te ayuda a decidir el siguiente paso.'
              }
            </p>
            
            <div className="suggestion-grid">
              {suggestions.map(({ icon: Icon, title, detail, prompt }, index) => {
                const customerPrompt = [
                  'Resume el historial de este cliente.', 
                  'Investiga los reclamos de este cliente y explícame qué pasó.', 
                  'Prepara una propuesta de atención para este cliente con evidencia.'
                ][index]
                
                return (
                  <button 
                    key={title} 
                    disabled={busy || !loaded} 
                    onClick={() => submit(customer ? customerPrompt : prompt)}
                  >
                    <span className="suggestion-icon">
                      <Icon size={18} strokeWidth={1.6} />
                    </span>
                    <ArrowUpRight className="suggestion-arrow" size={16} />
                    <strong>{customer && index === 0 ? 'Revisar historial' : title}</strong>
                    <span>{detail}</span>
                  </button>
                )
              })}
            </div>
            
            <div className="welcome-note">
              <Wrench size={13} /> Herramientas reales. Respuestas con contexto.
            </div>
          </section>
        ) : (
          <div className="message-list">
            {messages.map(message => { 
              const streaming = status === 'streaming' && message.role === 'assistant' && message.id === messages.at(-1)?.id
              
              return (
                <article key={message.id} className={`chat-message ${message.role}`}>
                  {message.role === 'assistant' && (
                    <div className="message-avatar"><Sparkles size={17} /></div>
                  )}
                  <div className="message-body">
                    {message.role === 'assistant' && (
                      <div className="message-author">
                        Churn AI <span>{streaming ? 'Escribiendo' : 'AGENTE'}</span>
                      </div>
                    )}
                    {message.parts.map((part, index) => 
                      part.type === 'text' ? (
                        <div key={index} className="message-text">
                          <MessageResponse 
                            mode={message.role === 'user' ? 'static' : 'streaming'} 
                            isAnimating={streaming && index === message.parts.length - 1} 
                            parseIncompleteMarkdown={message.role === 'assistant'} 
                            caret={streaming && index === message.parts.length - 1 ? 'block' : undefined}
                          >
                            {part.text}
                          </MessageResponse>
                        </div>
                      ) : part.type.startsWith('tool-') ? (
                        <ToolActivity key={index} part={part as ToolUIPart} onPlnText={submitPlnText} />
                      ) : null
                    )}
                  </div>
                </article>
              )
            })}
            
            {busy && (
              <div className="agent-thinking" role="status">
                <span /><span /><span /> 
                {status === 'submitted' ? 'Revisando tu pregunta' : 'Preparando respuesta'}
              </div>
            )}
          </div>
        )}
        <div ref={bottom} />
      </div>

      <div className="composer-area">
        {showLatest && (
          <button 
            type="button" 
            className="jump-to-latest" 
            aria-label="Ir al final de la conversación" 
            onClick={() => { 
              followResponse.current = true
              setShowLatest(false)
              bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) 
            }}
          >
            <ArrowDown size={14} /> Ir al final
          </button>
        )}
        
        {historyError && (
          <div className="chat-alert" role="status">
            No se pudo recuperar el historial. Puedes iniciar una conversación nueva.
          </div>
        )}
        
        {error && (
          <div className="chat-alert" role="alert">
            {friendlyError(error)} 
            <button onClick={() => void regenerate()}>Reintentar</button>
          </div>
        )}
        
        <form className="chat-composer" onSubmit={event => { event.preventDefault(); submit() }}>
          {customer && (
            <div className="composer-context">
              <Users size={12} /> Contexto: {customer.customerId}
            </div>
          )}
          <textarea 
            aria-label="Mensaje al agente" 
            placeholder={customer ? '¿Qué quieres saber de este cliente?' : 'Pregúntame algo o cuéntame qué necesitas…'} 
            value={input} 
            maxLength={10000} 
            rows={2} 
            onChange={event => { 
              setInput(event.target.value)
              event.target.style.height = 'auto'
              event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px` 
            }} 
            onKeyDown={event => { 
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { 
                event.preventDefault()
                submit() 
              } 
            }} 
          />
          <div className="composer-bottom">
            <span>
              <span className="agent-dot" /> Agente de retención 
              <span className="composer-divider">/</span> 
              <Wrench size={12} /> Herramientas activas
            </span>
            {busy ? (
              <button type="button" className="send-button" aria-label="Detener respuesta" onClick={() => void stop()}>
                <Square size={15} fill="currentColor" />
              </button>
            ) : (
              <button type="submit" className="send-button" disabled={!loaded || !input.trim()} aria-label="Enviar mensaje">
                <ArrowUp size={19} />
              </button>
            )}
          </div>
        </form>
        <p className="composer-disclaimer">La IA puede cometer errores. Revisa la evidencia antes de tomar una decisión.</p>
      </div>
    </div>
  )
}

export default function Chat() {
  const [source, setSource] = useState<Source | null>(null)
  const [cutoff, setCutoff] = useState('')
  const [selected, setSelected] = useState<Customer>()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [catalog, setCatalog] = useState<{ total: number; hasMore: boolean; source?: string; queryId?: string }>()
  const [catalogError, setCatalogError] = useState('')
  const [loading, setLoading] = useState(true)
  const [sidebar, setSidebar] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => { 
    const controller = new AbortController()
    
    const fetchDataSource = async () => {
      try {
        const response = await fetch('/api/data-source', { signal: controller.signal })
        if (!response.ok) throw new Error()
        const data: Source = await response.json()
        setSource(data)
        setCutoff(data.defaultCutoff)
      } catch (err) {
        if (!controller.signal.aborted) {
          setCatalogError('No se pudo verificar la conexión.')
          setCutoff(new Date().toISOString())
        }
      }
    }
    
    fetchDataSource()
    return () => controller.abort() 
  }, [])

  useEffect(() => {
    if (!cutoff) return
    const controller = new AbortController()
    
    const timer = setTimeout(async () => { 
      setLoading(true)
      setCatalogError('')
      
      try { 
        const params = new URLSearchParams({ cutoff, query, offset: String(offset) })
        const response = await fetch(`/api/customers?${params}`, { signal: controller.signal })
        const data = await response.json()
        
        if (!response.ok) throw new Error(data.error ?? 'No se pudo cargar la lista.')
        
        if (!controller.signal.aborted) { 
          setCustomers(previous => offset === 0 
            ? data.customers 
            : [...previous, ...data.customers.filter((item: Customer) => !previous.some(c => c.customerId === item.customerId))]
          )
          setCatalog(data) 
        } 
      } catch (error) { 
        if (!controller.signal.aborted) { 
          if (offset === 0) setCustomers([])
          setCatalogError(error instanceof Error ? error.message : 'No se pudo cargar la lista.') 
        } 
      } finally { 
        if (!controller.signal.aborted) setLoading(false) 
      } 
    }, 250)
    
    return () => { 
      clearTimeout(timer)
      controller.abort() 
    }
  }, [cutoff, query, offset, reload])

  const scope = useMemo(() => ({ customerId: selected?.customerId, cutoff }), [selected?.customerId, cutoff])
  
  const openCustomer = (customer?: Customer) => { 
    setSelected(customer)
    setSidebar(false) 
  }

  return (
    <main className="retention-app">
      {sidebar && (
        <button className="sidebar-scrim" aria-label="Cerrar lista de clientes" onClick={() => setSidebar(false)} />
      )}
      
      <aside className={`app-sidebar ${sidebar ? 'is-open' : ''}`}>
        <div className="sidebar-brand">
          <div className="brand-symbol"><Sparkles size={20} /></div>
          <div>churn<span>ai</span><small>RETENTION WORKSPACE</small></div>
          <button className="mobile-close icon-button" aria-label="Cerrar panel" onClick={() => setSidebar(false)}>
            <X size={18} />
          </button>
        </div>
        
        <button className={`new-chat ${!selected ? 'active' : ''}`} onClick={() => openCustomer()}>
          <Plus size={17} /> Conversación general <MessageSquare size={15} />
        </button>
        
        <div className="sidebar-section-title">
          <span>CLIENTES CON TICKETS</span>
          <span>{catalog?.total ?? '—'}</span>
        </div>
        
        <label className="customer-search">
          <Search size={15} />
          <input 
            aria-label="Buscar clientes" 
            placeholder="Buscar cliente…" 
            value={query} 
            onChange={event => { 
              setOffset(0)
              setQuery(event.target.value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80))
              setCustomers([])
              setCatalog(undefined) 
            }} 
          />
          {query && (
            <button aria-label="Limpiar búsqueda" onClick={() => { 
              setOffset(0)
              setQuery('')
              setCustomers([])
              setCatalog(undefined) 
            }}>
              <X size={13} />
            </button>
          )}
        </label>
        
        <div className="customer-list">
          {loading && customers.length === 0 ? (
            <div className="sidebar-state" role="status">
              <LoaderCircle className="animate-spin" size={18} />
              <span>Cargando clientes…</span>
            </div>
          ) : catalogError ? (
            <div className="sidebar-state">
              <CircleHelp size={23} />
              <strong>Conectemos tus datos</strong>
              <p>{catalogError}</p>
              <button onClick={() => setReload(value => value + 1)}>Reintentar</button>
            </div>
          ) : customers.length === 0 ? (
            <div className="sidebar-state">
              <Search size={20} />
              <strong>Sin resultados</strong>
              <p>Prueba con otro prefijo de cliente.</p>
            </div>
          ) : (
            customers.map((customer, index) => (
              <button 
                key={customer.customerId} 
                className={`customer-item ${selected?.customerId === customer.customerId ? 'selected' : ''}`} 
                onClick={() => openCustomer(customer)}
              >
                <span className={`customer-avatar tone-${index % 3}`}>
                  {customer.customerId.slice(-2)}
                </span>
                <span>
                  <strong>{customer.customerId}</strong>
                  <small>{customer.ticketCount} {customer.ticketCount === 1 ? 'ticket registrado' : 'tickets registrados'}</small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))
          )}
        </div>
        
        {catalog && !catalogError && (
          <div className="customer-pagination">
            <span>{customers.length} de {catalog.total} clientes con tickets</span>
            {catalog.hasMore && (
              <button disabled={loading} onClick={() => setOffset(customers.length)}>
                {loading ? 'Cargando…' : 'Cargar más clientes'}
              </button>
            )}
            <details>
              <summary>Fuente y consulta</summary>
              <p>{catalog.source ?? 'Demostración'}</p>
              {catalog.queryId && <p>Query ID: {catalog.queryId}</p>}
              <p>Se incluyen clientes con tickets y descripción hasta el corte. No es la tabla maestra de clientes.</p>
            </details>
          </div>
        )}
        
        <div className="sidebar-bottom">
          <div className="workspace-note">
            <ShieldCheck size={17} />
            <div><strong>Decisiones con evidencia</strong><span>Cada caso, en su contexto.</span></div>
          </div>
          <div className="settings-trigger">
            <span className="advisor-avatar">A</span>
            <span><strong>Espacio del asesor</strong><small>Uso local · tu espacio de trabajo</small></span>
          </div>
        </div>
      </aside>
      
      <section className="main-panel">
        <header className="workspace-header">
          <div className="header-location">
            <button className="mobile-menu icon-button" onClick={() => setSidebar(true)} aria-label="Abrir clientes">
              <PanelLeftOpen size={19} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{selected?.customerId ?? 'Conversación general'}</strong>
          </div>
          
          <div className="header-status">
            <span className={`status-pill ${source?.mode === 'demo' ? 'demo' : source?.serviceAvailable ? '' : 'offline'}`}>
              <span />
              {source?.mode === 'demo' ? 'Datos de demostración' : source?.serviceAvailable ? 'Snowflake' : source ? 'Sin conexión' : 'Conectando…'}
            </span>
            <span className="header-agent">Agente IA <Sparkles size={13} /></span>
          </div>
        </header>

        {selected && (
          <div className="case-context-bar">
            <span>
              <Users size={14} /> {selected.customerId} <small>· {selected.ticketCount} tickets</small>
            </span>
            <button onClick={() => openCustomer()}>
              Quitar contexto <X size={13} />
            </button>
          </div>
        )}
        
        {selected && (
          <CustomerEvidence key={selected.customerId} customerId={selected.customerId} cutoff={cutoff} />
        )}
        
        {cutoff ? (
          <AgentChat key={`${selected?.customerId ?? 'general'}:${cutoff}`} scope={scope} customer={selected} />
        ) : (
          <div className="initial-loading" role="status">
            <LoaderCircle size={23} className="animate-spin" /> Preparando tu espacio…
          </div>
        )}
      </section>
    </main>
  )
}