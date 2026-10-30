import { spawnSync } from 'node:child_process'
import { resolvePythonBinary } from './python-binary.mjs'
const result = spawnSync(resolvePythonBinary(), ['-m', 'services.pln.check_snowflake'], { stdio: 'inherit', env: process.env, windowsHide: true })
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
