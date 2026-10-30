import { dataMode } from '@/mastra/retention/service'

export async function GET() {
  let pln = null
  try {
    const configured = process.env.PLN_API_URL
    if (configured) {
      const url = new URL(configured)
      url.pathname = '/health'
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(3000) })
      if (response.ok) {
        const health = await response.json()
        pln = { modelDirectory: health.modelDirectory, modelVersion: health.modelVersion, snowflake: health.snowflake }
      }
    }
  } catch { /* Report service availability without leaking connection details. */ }
  return Response.json({ defaultCutoff: new Date().toISOString(), mode: dataMode(), authenticationRequired: false, serviceAvailable: pln !== null, pln }, { headers: { 'Cache-Control': 'no-store' } })
}
