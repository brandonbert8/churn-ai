import { spawn } from 'node:child_process';
import { resolvePythonBinary } from './python-binary.mjs';

const pythonBinary = resolvePythonBinary();

const args = [
  '-m',
  'uvicorn',
  'services.pln.app:app',
  '--host',
  '127.0.0.1',
  '--port',
  '8001'
];

const child = spawn(pythonBinary, args, {
  stdio: 'inherit',
  env: process.env
});

child.on('error', (err) => {
  console.error('\x1b[31m[Error al iniciar el proceso]\x1b[0m', err.message);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('exit', (code) => {
  process.exit(code ?? 1);
});