import { spawn } from 'node:child_process'
import { resolvePythonBinary } from './python-binary.mjs'

const children = new Set()
let stopping = false
function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  process.exitCode = code
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown())
function launch(command, args) {
  const child = spawn(command, args, { stdio: 'inherit', env: process.env, windowsHide: true })
  children.add(child)
  child.on('error', error => { console.error('No se pudo iniciar el servicio:', error.message); shutdown(1) })
  child.on('exit', code => { children.delete(child); if (!stopping) shutdown(code ?? 1) })
  return child
}
async function healthy(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok }
  catch { return false }
}
async function start() {
  if ((process.env.CHURN_DATA_MODE ?? 'live') === 'live') {
    const base = new URL(process.env.CHURN_EVIDENCE_API_URL ?? 'http://127.0.0.1:8001')
    const health = new URL('/health', base)
    if (!await healthy(health)) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || !['http:', 'https:'].includes(base.protocol)) throw new Error('El servicio de datos configurado no está disponible.')
      console.log('Iniciando datos de Snowflake y modelos PLN locales…')
      launch(resolvePythonBinary(), ['-m', 'uvicorn', 'services.pln.app:app', '--host', '127.0.0.1', '--port', base.port || '8001'])
      const deadline = Date.now() + 180000
      while (!stopping && !await healthy(health)) {
        if (Date.now() > deadline) throw new Error('El servicio PLN no terminó de iniciar. Revisa el error de Python mostrado arriba.')
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    if (stopping) return
    console.log('Servicio de datos disponible. Iniciando chat…')
  }
  launch(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--turbo', '--hostname', '127.0.0.1', ...process.argv.slice(2)])
}
start().catch(error => { console.error(error.message); shutdown(1) })
