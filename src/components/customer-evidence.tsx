'use client'
import { useEffect, useState } from 'react'
import { Database, LoaderCircle } from 'lucide-react'
type RecordSource = { reference: string; sourceId?: string; column?: string; table: string }
type Evidence = { mode: string; queryIds?: Record<string, string>; tickets: RecordSource[]; invoices: RecordSource[] }
export function CustomerEvidence({ customerId, cutoff }: { customerId: string; cutoff: string }) {
  const [data, setData] = useState<Evidence>()
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    fetch('/api/customers/' + encodeURIComponent(customerId) + '/evidence?' + new URLSearchParams({ cutoff }), { signal: controller.signal })
      .then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error); if (!controller.signal.aborted) setData(value) })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'No se pudo consultar la fuente.') })
    return () => controller.abort()
  }, [customerId, cutoff, open])
  return <details className="customer-evidence" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Database size={13} /> Ver registros originales y consultas de Snowflake</summary>
    <div className="evidence-body">{error ? <p role="alert">{error}</p> : !data ? <p role="status"><LoaderCircle size={13} className="animate-spin" /> Consultando registros…</p> : <>
      <p>Cliente: <code>{customerId}</code> · {data.mode === 'demo' ? 'DEMOSTRACIÓN' : 'Datos consultados en Snowflake'}</p>
      <p>El ID original es el valor que puedes buscar en Snowflake. La referencia interna añade SF-TICKET: o SF-INVOICE: para citar evidencias en el chat.</p>
      {([['Tickets', data.tickets, data.queryIds?.tickets], ['Facturas', data.invoices, data.queryIds?.invoices]] as const).map(([label, rows, queryId]) => <section key={label}><strong>{label} ({rows.length})</strong>{rows.length > 0 ? <><p>Tabla: <code>{rows[0].table}</code></p><div className="evidence-table-wrap"><table><thead><tr><th>Columna</th><th>ID original</th><th>Referencia interna</th></tr></thead><tbody>{rows.map(row => <tr key={row.reference}><td>{row.column ?? '—'}</td><td><code>{row.sourceId ?? 'No disponible'}</code></td><td><code>{row.reference}</code></td></tr>)}</tbody></table></div><pre>{'SELECT * FROM ' + rows[0].table + " WHERE TO_VARCHAR(ID_CLIENTE) = '" + customerId + "';"}</pre></> : <p>No hay registros disponibles para este corte.</p>}{queryId && <p>Query ID: <code>{queryId}</code></p>}</section>)}
    </>}</div>
  </details>
}
