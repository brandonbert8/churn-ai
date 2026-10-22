# Agente de investigación de retención

El agente Mastra sustituye el ejemplo del clima en `/chat`. Elige herramientas según las observaciones: consulta tickets, contrasta facturas o incidencias, revisa acciones permitidas y prepara un borrador. No ejecuta cambios comerciales. Las decisiones y resultados de herramientas se conservan como mensajes en la memoria de Mastra; no se almacenan razonamientos internos.

## Ejecutar

1. Instalar con `pnpm install`.
2. Configurar `OPENROUTER_API_KEY` en `.env`. Se respeta el proveedor existente; `RETENTION_MODEL` permite cambiar el modelo, que debe admitir herramientas.
3. `pnpm dev`, abrir `/chat`.
4. Mantener corte `2026-10-20T23:59:00Z` y elegir `DEMO-001` (cargos coincidentes), `DEMO-002` (incidencia abierta) o `DEMO-003` (datos incompletos).
5. Pedir «Investiga este caso y prepara una propuesta con referencias».

El modo predeterminado es `demo`. Los registros y políticas de ejemplo son ficticios y están identificados en interfaz, herramientas y respuesta. Los servicios PLN y churn no se simulan. Se puede investigar el caso con el LLM aunque esos modelos no estén conectados. Para probar sin consumo de LLM: `pnpm test`.

## Herramientas y límites

`getCustomerTimeline`, `compareInvoices`, `checkServiceIncidents`, `analyzeTicket`, `scoreChurn90d`, `evaluateAllowedActions`, `draftResolutionPlan`.

Hay seis operaciones distintas por turno (con caché y deduplicación concurrente) y ocho pasos de generación como máximo. El borrador requiere una política vigente y una acción elegible. Solo se permite revisión de facturación si hay cargos coincidentes; escalamiento técnico si hay incidencia abierta; solicitar datos si la política lo permite. Coincidencia de cargos no demuestra duplicidad ilegítima. Las cifras se calculan en centavos enteros de BOB.

El cliente y corte se fijan fuera del texto del modelo. El servidor valida el snapshot y filtra tanto la fecha del evento como su disponibilidad. El gateway debe devolver incidencias específicas del servicio del cliente y el estado conocido **en el corte**, no el estado actual de un evento antiguo. Correcciones históricas también necesitan su fecha de disponibilidad. Los IDs de evidencia deben ser únicos en el snapshot.

La memoria local se guarda en `.mastra/retention.db`, separada del ejemplo anterior. La memoria se separa por cookie aleatoria HttpOnly, cliente y corte. Se ignoran instrucciones/opciones/memoria/resultados de herramientas enviados en el cuerpo: solo se acepta el último mensaje de usuario; el historial procede del servidor. La cookie aísla sesiones, no autentica usuarios. El modo live exige `CHURN_APP_TOKEN`; la interfaz permite introducirlo temporalmente sin guardarlo en localStorage. Es un acceso de operador único, no un sistema multiusuario. Antes de usar datos empresariales, integrar SSO, autorización por cliente/tenant, retención de memoria y controles de acceso a la base Mastra.

## Conectar datos de Snowflake

Configurar `CHURN_DATA_MODE=live`, `CHURN_APP_TOKEN`, `CHURN_EVIDENCE_API_URL` y `CHURN_EVIDENCE_API_TOKEN`. El gateway autorizado debe ofrecer:

- `POST {base}/case-snapshot`, entrada `{customerId, cutoff}`, salida según `snapshotSchema` en `src/mastra/retention/contracts.ts`.
- `POST {base}/churn-score`, misma entrada, salida `{status:"available", customerId, cutoff, risk, horizonDays:90, calibrated:true, modelVersion, evidenceIds}`.

El snapshot contiene `customerId`, arrays `tickets`, `invoices`, `incidents`, `policies`. Toda evidencia incluye `id`, `source`, `occurredAt`, `availableAt` ISO. Los campos específicos están definidos y validados en el contrato Zod. `demo.ts` muestra ejemplos completos.

El gateway debe parametrizar consultas y aplicar autorización; no aceptar SQL generado por el LLM. La tabla conocida `DBT.BRONCE.STG_SOPORTE_TICKETS` aporta tickets; facturas, incidentes y políticas requieren fuentes verificadas adicionales. **No se ha implementado ni verificado un gateway Snowflake en esta entrega:** no existe en el repositorio y no se inventaron sus tablas. No se cambia automáticamente a demo si falla live.

## Conectar PLN y embeddings de Colab

Configurar `PLN_API_URL` con la URL completa del endpoint y `PLN_API_TOKEN`. Entrada:

```json
{"text":"Texto del ticket", "includeEmbedding":true}
```

Salida del servicio Python (un adaptador debe traducir los nombres si el contrato exportado por Colab usa otros):

```json
{
  "category":"FACTURACION",
  "scores":{"FACTURACION":0.7,"RED":0.3},
  "modelVersion":"tfidf-lr-v1",
  "calibrated":false,
  "productionReady":false,
  "embedding":{
    "modelVersion":"beto-revision-y-pooling-versionados",
    "dimensions":3,
    "pooling":"mean sin padding ni tokens especiales",
    "semanticSearchValidated":false,
    "vector":[0.12,-0.04,0.31]
  }
}
```

El vector de tres dimensiones es únicamente un ejemplo de contrato. BETO devuelve 768 valores: el servicio debe declarar `dimensions:768` y devolver los 768 números correspondientes. `embedding` es opcional (TF-IDF no es un embedding BETO). El servidor comprueba suma de scores, categoría y dimensiones, y envía al agente solo los metadatos de representación, evitando miles de valores en el contexto. No se calculan embeddings con el LLM, no hay vector store ni RAG obligatorio. El entrenamiento sigue en Colab. El servidor local `services/pln/app.py` carga la exportación provista, conserva la limpieza y devuelve la clasificación TF-IDF/LR junto con embeddings BETO de 768 dimensiones cuando se solicitan. No se entrena de nuevo. Un score de categoría no se convierte en probabilidad de churn.

La búsqueda de casos similares queda pendiente de validar con pares anotados y Recall@k/MRR. El pooling BETO demostrativo no acredita calidad de similitud semántica.

## Evaluación

Las pruebas locales cubren aislamiento de caso, fuga temporal, facturación, presupuesto concurrente, datos incompletos, esquema PLN/embeddings y elegibilidad/citas del borrador. Validan lógica determinista; no prueban que el LLM siempre elija herramientas correctamente.

Evaluar el agente con casos resueltos ocultando resoluciones y separando clientes/períodos. Comparar RAG, flujo fijo y agente adaptativo: diagnóstico por revisión experta, fidelidad a evidencia, acción válida, consultas útiles, abstención, costo y latencia. Incluir inyección de instrucciones, contradicciones y caída de servicios. Medir retención comercial mediante piloto controlado; las métricas PLN no prueban reducción de churn.

Referencias: [herramientas Mastra](https://mastra.ai/docs/agents/tools), documentación Next.js instalada en `node_modules/next/dist/docs/` y contratos de los paquetes fijados en `pnpm-lock.yaml`.

## Servidor PLN local con la exportación provista

Se usa `.mastra/models/tigo` para los archivos extraídos de `tigo_pln_modelo.zip`, conservando la exportación original. `PLN_MODEL_DIR` cambia esa ruta. Cargar solo exportaciones de confianza: joblib no es un formato seguro para archivos arbitrarios.

```sh
python3 services/pln/prepare.py
uv venv .venv-pln
uv pip install --python .venv-pln/bin/python -r services/pln/requirements.lock --torch-backend=cpu
.venv-pln/bin/python -m uvicorn services.pln.app:app --host 127.0.0.1 --port 8001
```

En el servidor Next configurar `PLN_API_URL=http://127.0.0.1:8001/analyze`. El servicio carga TF-IDF/LR y precarga BETO antes de indicar que está listo, evitando que la primera consulta exceda el timeout del agente. `PLN_PRELOAD_BETO=false` desactiva esa precarga. Todo se ejecuta en CPU, sin descargar modelos desde Hugging Face. Los pesos deben estar completos, incluido el tokenizador. El endpoint `/health` informa la versión; `/analyze` valida longitud y opcionalmente `PLN_API_TOKEN`. La escucha predeterminada recomendada es localhost.

Los embeddings se calculan promediando la última capa de BETO sin padding ni tokens especiales, igual que en la demostración del notebook. La clasificación procede del baseline seleccionado; no confundir el embedding BETO con los scores TF-IDF/LR. Su rendimiento limitado y falta de calibración se exponen en el contrato.

## Verificación de esta implementación

- `pnpm test`: siete pruebas de lógica aprobadas.
- `pnpm typecheck`: aprobado.
- `pnpm build`: aprobado con las rutas `/`, `/chat` y `/api/chat`.
- `python3 -m unittest discover -s services/pln -p 'test_*.py'`: dos pruebas HTTP aprobadas sobre el servicio local con los pesos provistos. Verifican ocho scores que suman uno, embedding finito de 768 dimensiones y rechazo de texto vacío.
- Prueba del modelo conversacional en el caso ficticio de facturación: eligió historial → comparación de facturas → elegibilidad → borrador con referencias, sin ejecutar acciones.
- Prueba desde el chat en el caso ficticio de red: eligió historial → PLN local → incidencias → elegibilidad → borrador de escalamiento, con `pending-human-review` y `executed:false`. El PLN clasificó incorrectamente como FACTURACION; el agente contrastó la incidencia técnica y dejó la clasificación para revisión. Se verificó rechazo de una cita inventada y se agregó feedback estructurado para corregirla sin aceptarla.

Estos controles verifican integración y lógica; no constituyen evaluación estadística del agente ni mejora demostrada de retención.
