import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { Observability, MastraStorageExporter, MastraPlatformExporter, SensitiveDataFilter } from '@mastra/observability';

import { retentionAgent } from './agents/retention-agent';


const databaseUrl = process.env.TURSO_DATABASE_URL ?? 'file:./.mastra/retention.db';
// LibSQL creates the file, but its parent directory must already exist.
if (databaseUrl.startsWith('file:') && databaseUrl !== 'file::memory:') {
  const databasePath = databaseUrl.startsWith('file://') ? fileURLToPath(databaseUrl) : resolve(databaseUrl.slice(5));
  mkdirSync(dirname(databasePath), { recursive: true });
}

export const mastra = new Mastra({
  agents: { retentionAgent },
  storage: new LibSQLStore({
    id: 'retention-storage',
    url: databaseUrl,
    authToken: process.env.TURSO_AUTH_TOKEN,
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new MastraStorageExporter(), // Persists observability events to Mastra Storage
          new MastraPlatformExporter(), // Sends observability events to Mastra Platform (if MASTRA_PLATFORM_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});
