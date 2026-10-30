# Churn AI · Tigo

Agente Mastra que consulta tickets en Snowflake, usa los modelos de `tigo_pln_modelo` y prepara una revisión con evidencia. El modo predeterminado es **live**; no usa DEMO si falla la conexión.

## Configurar y ejecutar

1. En `.env`, configurar `OPENROUTER_API_KEY`, `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PASSWORD` y `SNOWFLAKE_WAREHOUSE`. Para SSO o clave privada, consultar la documentación.
2. Mantener `CHURN_DATA_MODE=live`, `PLN_MODEL_DIR=tigo_pln_modelo`, `PLN_API_URL=http://127.0.0.1:8001/analyze` y `CHURN_EVIDENCE_API_URL=http://127.0.0.1:8001`.
3. La aplicación funciona en localhost sin login ni token del asesor. `CHURN_EVIDENCE_API_TOKEN` se configura en el servidor para la comunicación interna con el servicio PLN; no se solicita en la interfaz. Los comandos de inicio escuchan solo en `127.0.0.1`.
4. Instalar dependencias del servicio:

```sh
uv pip install --python .venv-pln/bin/python -r services/pln/requirements.lock -r services/pln/requirements-snowflake.txt --torch-backend=cpu
```

5. Iniciar toda la aplicación con un solo comando (levanta PLN/Snowflake, espera su disponibilidad y abre Next.js):

```sh
pnpm dev
```

El entorno Python local `.venv` o `.venv-pln` se detecta automáticamente también en Windows. `pnpm pln:dev` sigue disponible para iniciar solo el servicio Python.

Abrir `http://localhost:3000/chat` y comenzar a conversar directamente, sin tokens de acceso. Los clientes se cargan automáticamente en la lista lateral desde `DBT.BRONCE.STG_SOPORTE_TICKETS`. Se puede empezar a conversar sin ingresar un ID: el agente utiliza `searchCustomers` y `openCustomerCase` para buscar y abrir casos. Seleccionar un cliente de la lista fija el contexto; **Conversación general** permite volver a explorar. El corte temporal se establece automáticamente al abrir la página. El catálogo muestra 25 clientes con tickets por página, el total disponible y **Cargar más clientes**. No equivale a toda la tabla maestra de clientes. En cada caso, **Ver registros originales y consultas de Snowflake** muestra el ID original, la tabla y el Query ID. Las referencias `SF-INVOICE:` y `SF-TICKET:` son identificadores internos de evidencia; no forman parte de los IDs originales de Snowflake.

El servicio calcula clasificación TF-IDF/LR y embeddings BETO de 768 dimensiones con los archivos de la carpeta provista. Con `SNOWFLAKE_INVOICES_TABLE=DBT.ORO.FCT_FACTURACION` también contrasta facturas reales. Incidencias de red y políticas comerciales siguen sin fuente configurada; las propuestas requieren revisión humana.

Los comandos de Next.js utilizan Turbopack y Tailwind mediante PostCSS. Las bibliotecas nativas de memoria se cargan desde Node y la tipografía usa fuentes del sistema, sin descargar fuentes al compilar.

```sh
pnpm test
pnpm typecheck
.venv-pln/bin/python -m unittest services.pln.test_snowflake_data
```

[Conexión, autenticación, contratos y límites](docs/retention-agent.md).

Para contrastar los 25 clientes de la primera página con consultas SQL independientes y verificar sus referencias de facturación:

```sh
pnpm snowflake:audit
```

El informe local queda en `.mastra/source-audit.json` (ignorado por Git) e incluye la cuenta, tablas y Query IDs.

El agente también responde consultas como «Muéstrame los 10 clientes activos con más reclamos, sus nombres, IDs y probabilidades si están disponibles» mediante `rankCustomersByComplaints`. El ranking consulta toda la fuente y distingue reclamaciones de tickets totales. Actualmente los nombres y probabilidades no existen en las fuentes configuradas y se muestran como no disponibles; no se fabrican ni se deducen del número de tickets.
