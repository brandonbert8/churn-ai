# Churn AI · Tigo

Agente Mastra que consulta tickets en Snowflake, usa los modelos de `tigo_pln_modelo` y prepara una revisión con evidencia. El modo predeterminado es **live**; no usa DEMO si falla la conexión.

## Configurar y ejecutar

1. En `.env`, configurar `OPENROUTER_API_KEY`, `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PASSWORD` y `SNOWFLAKE_WAREHOUSE`. Para SSO o clave privada, consultar la documentación.
2. Mantener `CHURN_DATA_MODE=live`, `PLN_MODEL_DIR=tigo_pln_modelo`, `PLN_API_URL=http://127.0.0.1:8001/analyze` y `CHURN_EVIDENCE_API_URL=http://127.0.0.1:8001`.
3. Configurar dos secretos: `CHURN_APP_TOKEN` (acceso del asesor) y `CHURN_EVIDENCE_API_TOKEN` (comunicación interna). La configuración local ya tiene valores generados; no pegarlos en el chat ni versionar `.env`.
4. Instalar dependencias del servicio:

```sh
uv pip install --python .venv-pln/bin/python -r services/pln/requirements.lock -r services/pln/requirements-snowflake.txt --torch-backend=cpu
```

5. En dos terminales del proyecto:

```sh
pnpm pln:dev
```

```sh
pnpm dev
```

Abrir `/chat`, introducir el valor local de `CHURN_APP_TOKEN` en **Acceso del asesor** y pulsar **Consultar clientes**. La lista procede de `DBT.BRONCE.STG_SOPORTE_TICKETS`; seleccionar un cliente y pedir investigar sus tickets.

El servicio calcula clasificación TF-IDF/LR y embeddings BETO de 768 dimensiones con los archivos de la carpeta provista. Con `SNOWFLAKE_INVOICES_TABLE=DBT.ORO.FCT_FACTURACION` también contrasta facturas reales. Incidencias de red y políticas comerciales siguen sin fuente configurada; las propuestas requieren revisión humana.

Los comandos de Next.js utilizan Webpack y Tailwind mediante PostCSS. Las bibliotecas nativas de memoria se cargan desde Node y la tipografía usa fuentes del sistema, sin descargar fuentes al compilar.

```sh
pnpm test
pnpm typecheck
.venv-pln/bin/python -m unittest services.pln.test_snowflake_data
```

[Conexión, autenticación, contratos y límites](docs/retention-agent.md).
