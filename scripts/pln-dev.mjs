import { spawn } from 'node:child_process'
// Node loads .env without exposing credentials in command-line arguments.
const child = spawn('.venv-pln/bin/python', ['-m', 'uvicorn', 'services.pln.app:app', '--host', '127.0.0.1', '--port', '8001'], { stdio: 'inherit', env: process.env })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => process.exit(code ?? 1))
