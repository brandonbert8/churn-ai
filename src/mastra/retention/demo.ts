import type { Snapshot } from './contracts'

// Fictitious fixtures for demonstrations, never represented as Snowflake records.
export const DEMO_CUTOFF = '2026-10-20T23:59:00Z'
export function demoSnapshot(customerId: string): Snapshot | null {
  if (!['DEMO-001', 'DEMO-002', 'DEMO-003'].includes(customerId)) return null
  const stamp = { occurredAt: '2026-10-18T12:00:00Z', availableAt: '2026-10-18T12:00:00Z', source: 'fixture-ficticia-v1' }
  const texts: Record<string, string> = {
    'DEMO-001': 'Me cobraron dos veces el mismo servicio este mes y quiero cancelar.',
    'DEMO-002': 'La conexión se corta todos los días. No quiero seguir pagando así.',
    'DEMO-003': 'El monto no coincide, pero no tengo el comprobante ni recuerdo el período.',
  }
  return {
    customerId,
    tickets: [{ ...stamp, id: `${customerId}-T1`, text: texts[customerId] }],
    invoices: customerId === 'DEMO-003' ? [] : [
      { ...stamp, id: `${customerId}-C1`, serviceId: 'internet-hogar', period: '2026-10', chargeCode: 'mensualidad', amountMinor: 15000, currency: 'BOB' },
      ...(customerId === 'DEMO-001' ? [{ ...stamp, id: `${customerId}-C2`, serviceId: 'internet-hogar', period: '2026-10', chargeCode: 'mensualidad', amountMinor: 15000, currency: 'BOB' as const }] : []),
    ],
    incidents: customerId === 'DEMO-002' ? [{ ...stamp, id: `${customerId}-I1`, summary: 'Intermitencia confirmada en el servicio del cliente', resolved: false }] : [],
    policies: [
      { ...stamp, id: 'DEMO-P1', action: 'BILLING_REVIEW', description: 'Abrir revisión de posible duplicidad. No ejecutar devolución automática.', expiresAt: '2026-12-31T23:59:59Z' },
      { ...stamp, id: 'DEMO-P2', action: 'NETWORK_ESCALATION', description: 'Escalar incidencia abierta al equipo técnico.', expiresAt: '2026-12-31T23:59:59Z' },
      { ...stamp, id: 'DEMO-P3', action: 'REQUEST_DETAILS', description: 'Solicitar período y comprobante para completar el diagnóstico.', expiresAt: '2026-12-31T23:59:59Z' },
    ],
  }
}
