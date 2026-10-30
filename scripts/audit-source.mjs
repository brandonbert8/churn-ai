import { spawnSync } from 'node:child_process'
import { resolvePythonBinary } from './python-binary.mjs'
const result = spawnSync(resolvePythonBinary(), ['-m', 'services.pln.audit_source'], { env: process.env, stdio: 'inherit', windowsHide: true })
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
