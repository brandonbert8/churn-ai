import { existsSync } from 'node:fs';
import path from 'node:path';
const isWindows = process.platform === 'win32';
export function resolvePythonBinary() {
  // 1. Si hay un entorno virtual activado en la terminal (ej. churn-ai)
  if (process.env.VIRTUAL_ENV) {
    const venvBin = isWindows
      ? path.join(process.env.VIRTUAL_ENV, 'Scripts', 'python.exe')
      : path.join(process.env.VIRTUAL_ENV, 'bin', 'python');

    if (existsSync(venvBin)) {
      return venvBin;
    }
  }

  // 2. Si existe una carpeta local en el proyecto
  const candidates = ['.venv-pln', '.venv', 'venv', '.churn-ai'];
  for (const dir of candidates) {
    const candidateBin = isWindows
      ? path.join(dir, 'Scripts', 'python.exe')
      : path.join(dir, 'bin', 'python');

    if (existsSync(candidateBin)) {
      return candidateBin;
    }
  }

  // 3. Fallback al python disponible en el PATH del sistema / terminal
  return isWindows ? 'python.exe' : 'python';
}

