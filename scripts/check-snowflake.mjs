import { spawnSync } from 'node:child_process'
const result = spawnSync('.venv-pln/bin/python', ['-m', 'services.pln.check_snowflake'], { stdio: 'inherit', env: process.env })
process.exit(result.status ?? 1)
