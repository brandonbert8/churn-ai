# Retención con Snowflake y PLN local

## Datos del agente

El modo predeterminado es `live`. El agente consulta el servicio local, que ejecuta consultas SELECT parametrizadas mediante el conector oficial de Snowflake. No recibe SQL del LLM y no utiliza un caso ficticio si falla una consulta.

Fuente verificada del proyecto: `DBT.BRONCE.STG_SOPORTE_TICKETS`. Se comprueba que existan `ID_CLIENTE`, `ID_TICKET`, `FECHA_CREACION` y `DESCRIPCION_ES` antes de consultar. La categoría operativa no se envía como entrada al clasificador.

- `GET /customers?cutoff=...&query=...`: hasta 25 clientes con tickets hasta el corte, por prefijo de ID. IDs, conteos y fechas proceden de Snowflake.
- `POST /case-snapshot`: `{customerId, cutoff}`. Devuelve hasta 200 tickets recientes con ID de evidencia, tabla y query ID de Snowflake.
- `POST /churn-score`: devuelve no disponible; la exportación PLN no contiene un predictor calibrado de abandono a 90 días.

La tabla `DBT.ORO.FCT_FACTURACION` fue verificada en el catálogo y consultada con un cliente real. `SNOWFLAKE_INVOICES_TABLE` habilita hasta 500 facturas emitidas antes del corte. Cada factura conserva ID, suscripción, período, fuente y total en centavos de BOB, convertido con redondeo decimal. Se comparan totales de facturas, no pagos ni conceptos individuales: una coincidencia solo es candidata a revisión. `queryIds` conserva las consultas de tickets y facturas.

Incidencias de red y políticas comerciales se devuelven vacías con `availability: not_configured`, no como ausencia demostrada de problemas. Sin tabla de facturas configurada se conserva la misma distinción. No se fabrican ofertas o políticas: `MANUAL_REVIEW` prepara un resumen para revisión humana con estado `pending-policy-validation`; no autoriza acciones comerciales.

## Configuración

Usar el `.env` local (ignorado por Git). `pnpm pln:dev` utiliza Node para cargar sus valores y pasarlos al proceso Python; no pone credenciales en argumentos de procesos.

```dotenv
CHURN_DATA_MODE=live
PLN_MODEL_DIR=tigo_pln_modelo
PLN_API_URL=http://127.0.0.1:8001/analyze
CHURN_EVIDENCE_API_URL=http://127.0.0.1:8001
SNOWFLAKE_ACCOUNT=organizacion-cuenta
SNOWFLAKE_USER=usuario
SNOWFLAKE_WAREHOUSE=warehouse_existente
SNOWFLAKE_AUTHENTICATOR=snowflake
SNOWFLAKE_TICKETS_TABLE=DBT.BRONCE.STG_SOPORTE_TICKETS
SNOWFLAKE_INVOICES_TABLE=DBT.ORO.FCT_FACTURACION
SNOWFLAKE_SOURCE_TIMEZONE=UTC
```

Añadir `SNOWFLAKE_PASSWORD` localmente si se usa contraseña. Nunca compartirla en chat ni incorporarla a código. `SNOWFLAKE_ROLE` es opcional: usar un rol con SELECT sobre la fuente existente. No se crean roles, tablas ni permisos.

Alternativas de autenticación soportadas por el conector:

- SSO: `SNOWFLAKE_AUTHENTICATOR=externalbrowser`. Ejecutar el servicio desde una terminal con navegador disponible y completar el acceso de Snowflake.
- Clave privada: `SNOWFLAKE_AUTHENTICATOR=SNOWFLAKE_JWT`, `SNOWFLAKE_PRIVATE_KEY_FILE` y, si está cifrada, `SNOWFLAKE_PRIVATE_KEY_PASSWORD`.
- OAuth: `SNOWFLAKE_AUTHENTICATOR=oauth` y `SNOWFLAKE_TOKEN`.

La aplicación está pensada para uso local en la laptop: el chat y el catálogo funcionan en localhost sin autenticación del asesor. Los comandos de inicio escuchan solo en `127.0.0.1` y la API rechaza hosts remotos y orígenes distintos. `CHURN_EVIDENCE_API_TOKEN` autentica internamente Next.js ante el servicio PLN y no se solicita en la interfaz.

## Instalación e inicio

```sh
uv pip install --python .venv-pln/bin/python -r services/pln/requirements.lock -r services/pln/requirements-snowflake.txt --torch-backend=cpu
pnpm pln:dev
```

En otra terminal, `pnpm dev`. El servicio escucha en localhost:8001 y la interfaz en localhost:3000/chat. La pantalla informa si faltan credenciales, el driver o el servicio. `/api/data-source` expone estado de configuración sin valores secretos. No abre una sesión de Snowflake solo por consultar ese estado.

El conector oficial está instalado en el entorno local del proyecto.

## Modelo provisto: tigo_pln_modelo

El servicio carga **directamente** la carpeta del proyecto: `tfidf_logistic.joblib`, `labels.json`, `manifest.json` y los pesos/tokenizador en `beto/`. No sustituye los pesos por otro modelo descargado. `PLN_MODEL_DIR` permite cambiar explícitamente la ruta. Las exportaciones joblib deben ser de confianza; no existe un endpoint para subir y ejecutar archivos arbitrarios.

`POST /analyze` recibe `{text, includeEmbedding:true}`. Aplica la misma limpieza de la exportación, devuelve las ocho categorías y scores de TF-IDF/LR, versión, calibración y `productionReady`. BETO produce un embedding de 768 valores mediante promedio de la última capa, excluyendo padding y tokens especiales. Se precarga antes de declarar que el servicio está listo.

El adaptador comprueba los scores y dimensiones. Al LLM se le envían la categoría y los metadatos del embedding, no sus 768 valores. El vector completo sigue disponible en la respuesta del servicio PLN. No hay recuperación vectorial ni RAG obligatorio. La clasificación de reclamo no equivale a sentimiento, intención ni riesgo de abandono; un promedio BETO no acredita calidad de búsqueda semántica.

La inferencia directa fue verificada con esta carpeta: ocho scores sumando uno y 768 valores de embedding. El manifiesto mantiene `production_ready=false` y scores sin calibrar; el corpus tiene solo 28 textos distintos.

## Temporalidad y trazabilidad

Se filtra `FECHA_CREACION` por el corte. Si existe una columna real de ingesta/disponibilidad, configurar `SNOWFLAKE_AVAILABLE_AT_COLUMN`: su existencia se valida en el catálogo antes de usarla y también se filtra por el corte. Sin esa columna se aproxima disponibilidad por creación y se incluye una advertencia: **no es un backtest libre de fuga verificado**.

Los timestamps NTZ se interpretan con `SNOWFLAKE_SOURCE_TIMEZONE`; UTC es el valor predeterminado, no una afirmación sobre la zona original. Cambiarlo solo con evidencia de la fuente. Los registros con timestamps zonificados conservan su instante.

Cada ticket conserva su tabla y el snapshot conserva `queryId`. La memoria se separa por sesión HttpOnly, modo, cliente y corte. Se acepta únicamente el último mensaje del asesor del navegador: el historial y los resultados de herramientas proceden del servidor. Los IDs de cita deben pertenecer al caso; una referencia inventada solicita corrección en vez de aprobar el borrador.

## Verificaciones y pendientes

Las pruebas cubren consultas parametrizadas, validación de identificadores/columnas, fuente y query ID, filtrado temporal, IDs duplicados, presupuesto de herramientas, scores/embeddings, ausencia de fuentes y revisión humana sin políticas. Las conexiones unitarias de Snowflake son dobles de prueba; **no prueban autenticación ni filas de una cuenta real**.

Para verificar la conexión real: instalar el driver, completar la autenticación local y ejecutar `pnpm snowflake:check`. El comando consulta filas reales, ejecuta el PLN y muestra fuente/query ID/dimensiones sin imprimir textos ni credenciales. También se pueden consultar clientes en la interfaz. La consulta debe devolver query ID y tabla reales; después investigar un ticket con `analyzeTicket`. No afirmar conexión efectiva antes de ese resultado.

Verificación real del 22 de octubre de 2026: el caso `CLI-002301` devolvió un ticket y dos facturas, con consultas `01c7e666-0002-82a7-0002-cb06000e91b2` y `01c7e666-0002-82c9-0002-cb06000ef076`. La inferencia del ticket devolvió ocho clases y un embedding de 768 dimensiones. Queda pendiente una fuente de incidencias de red y políticas comerciales. La disponibilidad de facturas se aproxima con `FECHA_EMISION`; tampoco constituye un backtest verificado.

La prueba completa de `POST /api/chat` finalizó con HTTP 200 y stream terminado, sin errores de herramientas. El agente invocó `getCustomerTimeline`, `compareInvoices`, `analyzeTicket`, `evaluateAllowedActions` y `draftResolutionPlan`; produjo `MANUAL_REVIEW` con `pending-policy-validation` y `executed:false`. La prueba verifica integración y trazabilidad, no exactitud lingüística ni eficacia para reducir churn.

La compilación de producción `pnpm build` terminó correctamente con Webpack, Tailwind/PostCSS y las bibliotecas nativas de LibSQL externas al empaquetado. Pasaron las nueve pruebas TypeScript, seis pruebas del adaptador Snowflake y dos de inferencia HTTP con el modelo local. La interfaz también se verificó consultando clientes y recibiendo la síntesis del caso real.

Fuentes: [conexión oficial Python](https://docs.snowflake.com/en/developer-guide/python-connector/python-connector-connect), [consultas con parámetros](https://docs.snowflake.com/en/developer-guide/python-connector/python-connector-example), [herramientas Mastra](https://mastra.ai/docs/agents/tools).

## Paginación y trazabilidad

`GET /customers` y `/api/customers` aceptan `offset` (0, 25, 50, etc.). Devuelven `total`, `pageSize`, `hasMore`, `source` y `queryId`. El universo son clientes con tickets y descripción hasta el corte, no toda la tabla maestra.

Cada ticket y factura live conserva `sourceId` y `sourceIdColumn`, con el identificador original de Snowflake. El campo `id` conserva la referencia interna para validar evidencias (`SF-TICKET:` o `SF-INVOICE:`). `/api/customers/{customerId}/evidence?cutoff=...` muestra únicamente referencias y metadatos del caso, sin enviar registros a un modelo.

## Ranking agregado de reclamos

La herramienta `rankCustomersByComplaints` consulta `POST /customer-ranking` con el corte fijado por el servidor. Parámetros: `limit` (1–50, por defecto 10), `metric` (`complaints` o `tickets`), `minTickets`, `lookbackDays` (null = todo el historial) y `activeOnly` (true por defecto). SQL agrupa toda la fuente antes de limitar; no clasifica la primera página del catálogo.

Se cuentan IDs distintos de tickets. `complaints` usa CATEGORIA = reclamacion, sin distinguir mayúsculas; las demás categorías se incluyen solo en el conteo de tickets totales. Se unen los IDs de la fuente de tickets con `SNOWFLAKE_CUSTOMERS_TABLE` (predeterminada `DBT.ORO.DIM_CLIENTES`). El filtro activo excluye bajas históricas conocidas al corte, sin convertir CHURN en riesgo futuro.

La respuesta incluye cliente, nombre original si existe, conteos, último ticket, cobertura de fechas, tablas y Query IDs. En las fuentes actuales no hay nombres ni predictor validado: `customerName` y `churnProbability` son null. La priorización por reclamos no demuestra una mayor probabilidad de abandono. No se calcula una probabilidad a partir del PLN, tasas históricas ni conteos.
