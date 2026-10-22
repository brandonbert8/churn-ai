# Churn AI · Tigo

Agente Mastra integrado con Next.js para investigar reclamos y preparar propuestas de atención con evidencia. El agente usa herramientas de facturación, incidencias, historial y PLN; no ejecuta acciones comerciales.

```sh
pnpm install
pnpm dev
```

Configurar `OPENROUTER_API_KEY` en `.env` y abrir `http://localhost:3000/chat`.

Por defecto utiliza **casos ficticios identificados**: DEMO-001, DEMO-002 y DEMO-003. El corte de demostración es `2026-10-20T23:59:00Z`. Pedir: «Investiga este caso y prepara una propuesta con referencias».

```sh
pnpm test
pnpm typecheck
pnpm build
```

El servicio PLN local carga los modelos exportados de Colab; después de preparar el entorno según la documentación, iniciarlo en una segunda terminal con `pnpm pln:dev`. Los datos empresariales de Snowflake requieren un gateway autorizado de evidencia. [Configuración, contratos y límites](docs/retention-agent.md).
