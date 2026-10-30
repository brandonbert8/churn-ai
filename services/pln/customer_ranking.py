"""Read-only cross-customer complaint ranking; never invent churn probabilities."""
from datetime import timedelta
import os
import re
from services.pln import snowflake_data as source


def customer_table():
    value = os.environ.get('SNOWFLAKE_CUSTOMERS_TABLE', 'DBT.ORO.DIM_CLIENTES')
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*', value):
        raise source.SourceError('INVALID_TABLE', 'La tabla de clientes debe ser BASE.ESQUEMA.TABLA.')
    return value.upper()


def rank_customers(connection, cutoff, limit=10, metric='complaints', min_tickets=1, lookback_days=None, active_only=True):
    if not isinstance(limit, int) or not 1 <= limit <= 50 or metric not in ('complaints', 'tickets'):
        raise source.SourceError('MISSING_CONFIGURATION', 'Ranking o límite de clientes no válidos.', 400)
    if not isinstance(min_tickets, int) or not 1 <= min_tickets <= 1000000:
        raise source.SourceError('MISSING_CONFIGURATION', 'El mínimo de tickets no es válido.', 400)
    if lookback_days is not None and (not isinstance(lookback_days, int) or not 1 <= lookback_days <= 3650):
        raise source.SourceError('MISSING_CONFIGURATION', 'El período de análisis no es válido.', 400)
    ticket_columns = source.verified_columns(connection)
    if metric == 'complaints' and 'CATEGORIA' not in ticket_columns:
        raise source.SourceError('SCHEMA_MISMATCH', 'La fuente no tiene CATEGORIA para distinguir reclamaciones de otros tickets.')
    table = customer_table()
    database, schema, name = table.split('.')
    with connection.cursor() as cursor:
        cursor.execute(f'SELECT COLUMN_NAME FROM {database}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s', (schema, name))
        columns = {row[0] for row in cursor.fetchall()}
        if not {'ID_CLIENTE', 'CHURN', 'FECHA_CHURN'} <= columns:
            raise source.SourceError('SCHEMA_MISMATCH', 'La fuente de clientes necesita ID_CLIENTE, CHURN y FECHA_CHURN para separar bajas históricas.')
    name_column = next((column for column in ['NOMBRE_COMPLETO', 'NOMBRE', 'RAZON_SOCIAL'] if column in columns), None)
    name_expr = f'MAX(TO_VARCHAR(c.{name_column}))' if name_column else 'CAST(NULL AS VARCHAR)'
    cutoff_stamp = source.cutoff_value(cutoff)
    start_stamp = cutoff_stamp - timedelta(days=lookback_days) if lookback_days is not None else None
    complaint_expr = "COUNT(DISTINCT CASE WHEN UPPER(TRIM(t.CATEGORIA)) = 'RECLAMACION' THEN t.ID_TICKET END)" if 'CATEGORIA' in ticket_columns else 'NULL'
    ranking_expr = 'COMPLAINT_COUNT' if metric == 'complaints' else 'TICKET_COUNT'
    active_clause = "AND (TRY_TO_NUMBER(TO_VARCHAR(c.CHURN)) = 0 OR TRY_TO_TIMESTAMP_NTZ(NULLIF(TO_VARCHAR(c.FECHA_CHURN), '')) > %s)" if active_only else ''
    available_column = os.environ.get('SNOWFLAKE_AVAILABLE_AT_COLUMN')
    if available_column and (not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_$]*', available_column) or available_column.upper() not in ticket_columns):
        raise source.SourceError('SCHEMA_MISMATCH', 'La columna de disponibilidad no existe en la fuente de tickets.')
    availability_clause = f'AND TRY_TO_TIMESTAMP_NTZ(t.{available_column.upper()}) <= %s' if available_column else ''
    parameters = [cutoff_stamp, cutoff_stamp]
    if start_stamp is not None:
        parameters.append(start_stamp)
    if available_column:
        parameters.append(cutoff_stamp)
    if active_only:
        parameters.append(cutoff_stamp)
    parameters += [min_tickets, limit]
    # GROUP BY covers the complete source before LIMIT: never rank just one catalog page.
    sql = f'''
        WITH ranked AS (
            SELECT TO_VARCHAR(c.ID_CLIENTE) AS CUSTOMER_ID,
                   {name_expr} AS CUSTOMER_NAME,
                   COUNT(DISTINCT t.ID_TICKET) AS TICKET_COUNT,
                   {complaint_expr} AS COMPLAINT_COUNT,
                   MAX(TRY_TO_TIMESTAMP_NTZ(t.FECHA_CREACION)) AS LAST_TICKET_AT,
                   MAX(CASE WHEN TRY_TO_NUMBER(TO_VARCHAR(c.CHURN)) = 1
                       AND TRY_TO_TIMESTAMP_NTZ(NULLIF(TO_VARCHAR(c.FECHA_CHURN), '')) <= %s THEN 1 ELSE 0 END) AS ALREADY_CHURNED
            FROM {source.table_name()} t
            JOIN {table} c ON TO_VARCHAR(t.ID_CLIENTE) = TO_VARCHAR(c.ID_CLIENTE)
            WHERE t.ID_TICKET IS NOT NULL
              AND TRY_TO_TIMESTAMP_NTZ(t.FECHA_CREACION) <= %s
              {'AND TRY_TO_TIMESTAMP_NTZ(t.FECHA_CREACION) >= %s' if start_stamp is not None else ''}
              {availability_clause}
              {active_clause}
            GROUP BY c.ID_CLIENTE
        )
        SELECT CUSTOMER_ID, CUSTOMER_NAME, TICKET_COUNT, COMPLAINT_COUNT, LAST_TICKET_AT,
               ALREADY_CHURNED, COUNT(*) OVER() AS TOTAL_ELIGIBLE
        FROM ranked WHERE {ranking_expr} >= %s
        ORDER BY {ranking_expr} DESC, LAST_TICKET_AT DESC, CUSTOMER_ID ASC LIMIT %s
    '''
    with connection.cursor() as cursor:
        cursor.execute(sql, tuple(parameters))
        rows, query_id = cursor.fetchall(), cursor.sfqid
    with connection.cursor() as cursor:
        cursor.execute(f'SELECT MAX(TRY_TO_TIMESTAMP_NTZ(FECHA_CREACION)) FROM {source.table_name()} WHERE TRY_TO_TIMESTAMP_NTZ(FECHA_CREACION) <= %s', (cutoff_stamp,))
        latest = cursor.fetchone()[0]
        coverage_query_id = cursor.sfqid
    customers = [{
        'customerId': str(row[0]), 'customerName': str(row[1]) if row[1] is not None else None,
        'ticketCount': int(row[2]), 'complaintCount': int(row[3]) if row[3] is not None else None,
        'lastTicketAt': source.iso(row[4]), 'alreadyChurned': bool(row[5]),
        'churnProbability': None,
    } for row in rows]
    warnings = [
        'Ranking por volumen de tickets, no por probabilidad de abandono. Más reclamos no prueban mayor riesgo.',
        'CHURN y FECHA_CHURN son bajas históricas, no probabilidades. El modelo PLN clasifica tickets, no predice abandono.',
        'Los perfiles y fechas de disponibilidad histórica no están versionados; no es un backtest temporal verificado.',
    ]
    if not name_column:
        warnings.append('La tabla de clientes no contiene nombre; customerName se devuelve null, sin inventarlo.')
    if latest is not None and (cutoff_stamp - source.cutoff_value(source.iso(latest))).days > 30:
        warnings.append('El historial de tickets termina más de 30 días antes del corte; el ranking puede describir actividad antigua.')
    return {
        'status': 'available', 'mode': 'live', 'cutoff': cutoff,
        'periodStart': source.iso(start_stamp) if start_stamp is not None else None,
        'metric': metric, 'activeOnly': active_only, 'minimumTickets': min_tickets,
        'totalEligible': int(rows[0][6]) if rows else 0,
        'customers': customers, 'queryId': query_id,
        'sources': {'tickets': source.table_name(), 'customers': table},
        'sourceCoverage': {'latestTicketAt': source.iso(latest) if latest is not None else None, 'queryId': coverage_query_id},
        'nameAvailability': 'available' if name_column else 'not_configured',
        'probability': {'status': 'unavailable', 'horizonDays': 90, 'reason': 'No hay un modelo validado ni una tabla de probabilidades de abandono en las fuentes configuradas.'},
        'complaintDefinition': "CATEGORIA = 'reclamacion' (sin distinguir mayúsculas). Las demás categorías solo se cuentan en ticketCount.",
        'warnings': warnings,
    }
