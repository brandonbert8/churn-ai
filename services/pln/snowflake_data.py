"""Read-only Snowflake ticket source. Values are bound, identifiers are allowlisted."""
from contextlib import contextmanager
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
import importlib.util
import os
import re
from zoneinfo import ZoneInfo


class SourceError(Exception):
    def __init__(self, code, message, status=503):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


def table_name():
    value = os.environ.get('SNOWFLAKE_TICKETS_TABLE', 'DBT.BRONCE.STG_SOPORTE_TICKETS')
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*', value):
        raise SourceError('INVALID_TABLE', 'La tabla de tickets debe ser BASE.ESQUEMA.TABLA con identificadores simples.')
    return value.upper()


def configuration_status():
    required = ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_USER', 'SNOWFLAKE_WAREHOUSE']
    method = os.environ.get('SNOWFLAKE_AUTHENTICATOR', 'snowflake')
    if method == 'snowflake': required.append('SNOWFLAKE_PASSWORD')
    elif method == 'SNOWFLAKE_JWT': required.append('SNOWFLAKE_PRIVATE_KEY_FILE')
    elif method == 'oauth': required.append('SNOWFLAKE_TOKEN')
    missing = [name for name in required if not os.environ.get(name)]
    try:
        installed = importlib.util.find_spec('snowflake.connector') is not None
    except ModuleNotFoundError:
        installed = False
    return {'configured': not missing, 'missingVariables': missing, 'driverInstalled': installed, 'table': table_name()}


@contextmanager
def connect():
    status = configuration_status()
    if status['missingVariables']:
        raise SourceError('MISSING_CONFIGURATION', 'Falta configurar: ' + ', '.join(status['missingVariables']))
    if not status['driverInstalled']:
        raise SourceError('MISSING_DRIVER', 'Instala services/pln/requirements-snowflake.txt en .venv-pln para habilitar Snowflake.')
    import snowflake.connector
    method = os.environ.get('SNOWFLAKE_AUTHENTICATOR', 'snowflake')
    options = {
        'account': os.environ['SNOWFLAKE_ACCOUNT'], 'user': os.environ['SNOWFLAKE_USER'],
        'warehouse': os.environ['SNOWFLAKE_WAREHOUSE'], 'authenticator': method,
        'login_timeout': 20, 'network_timeout': 20,
        'session_parameters': {'TIMEZONE': 'UTC', 'QUERY_TAG': 'churn-ai-readonly', 'STATEMENT_TIMEOUT_IN_SECONDS': 20},
    }
    if os.environ.get('SNOWFLAKE_ROLE'): options['role'] = os.environ['SNOWFLAKE_ROLE']
    if method == 'snowflake': options['password'] = os.environ['SNOWFLAKE_PASSWORD']
    elif method == 'SNOWFLAKE_JWT':
        options['private_key_file'] = os.environ['SNOWFLAKE_PRIVATE_KEY_FILE']
        if os.environ.get('SNOWFLAKE_PRIVATE_KEY_PASSWORD'):
            options['private_key_file_pwd'] = os.environ['SNOWFLAKE_PRIVATE_KEY_PASSWORD']
    elif method == 'oauth': options['token'] = os.environ['SNOWFLAKE_TOKEN']
    connection = None
    try:
        connection = snowflake.connector.connect(**options)
        yield connection
    except SourceError:
        raise
    except Exception as error:
        # Snowflake errors can contain connection details. Do not return them to the LLM/browser.
        raise SourceError('SNOWFLAKE_UNAVAILABLE', 'No se pudo consultar Snowflake. Revisa conexión, autenticación y permisos SELECT.') from error
    finally:
        if connection is not None: connection.close()


def iso(value):
    if isinstance(value, str): value = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if isinstance(value, date) and not isinstance(value, datetime): value = datetime.combine(value, datetime.min.time())
    if value.tzinfo is None:
        value = value.replace(tzinfo=ZoneInfo(os.environ.get('SNOWFLAKE_SOURCE_TIMEZONE', 'UTC')))
    return value.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def cutoff_value(value):
    # FECHA_CREACION is interpreted using the declared source timezone when it is NTZ.
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(
        ZoneInfo(os.environ.get('SNOWFLAKE_SOURCE_TIMEZONE', 'UTC'))
    ).replace(tzinfo=None)


def verified_columns(connection):
    database, schema, table = table_name().split('.')
    with connection.cursor() as cursor:
        cursor.execute(f'SELECT COLUMN_NAME FROM {database}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s', (schema, table))
        columns = {row[0] for row in cursor.fetchall()}
    required = {'ID_TICKET', 'ID_CLIENTE', 'FECHA_CREACION', 'DESCRIPCION_ES'}
    if not required <= columns:
        raise SourceError('SCHEMA_MISMATCH', 'La tabla no contiene las columnas verificadas necesarias para tickets.')
    return columns


def list_customers(connection, cutoff, query=''):
    verified_columns(connection)
    with connection.cursor() as cursor:
        cursor.execute(f'''
            SELECT TO_VARCHAR(ID_CLIENTE), COUNT(*), MAX(FECHA_CREACION)
            FROM {table_name()}
            WHERE FECHA_CREACION <= %s AND ID_CLIENTE IS NOT NULL
              AND DESCRIPCION_ES IS NOT NULL
              AND STARTSWITH(UPPER(TO_VARCHAR(ID_CLIENTE)), UPPER(%s))
            GROUP BY ID_CLIENTE ORDER BY MAX(FECHA_CREACION) DESC, ID_CLIENTE LIMIT 25
        ''', (cutoff_value(cutoff), query))
        rows, query_id = cursor.fetchall(), cursor.sfqid
    return {'mode': 'live', 'source': table_name(), 'queryId': query_id,
            'customers': [{'customerId': str(row[0]), 'ticketCount': int(row[1]), 'lastTicketAt': iso(row[2])} for row in rows]}


def invoice_evidence(connection, customer_id, cutoff):
    """Invoice totals are comparable candidates, never proof of a duplicate payment."""
    table = os.environ.get('SNOWFLAKE_INVOICES_TABLE', '')
    if not table:
        return [], None, []
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*', table):
        raise SourceError('INVALID_TABLE', 'La tabla de facturas debe ser BASE.ESQUEMA.TABLA.')
    table = table.upper()
    database, schema, name = table.split('.')
    with connection.cursor() as cursor:
        cursor.execute(f'SELECT COLUMN_NAME FROM {database}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s', (schema, name))
        columns = {row[0] for row in cursor.fetchall()}
        required = {'ID_FACTURA', 'ID_CLIENTE', 'ID_SUSCRIPCION', 'PERIODO_FACTURACION', 'FECHA_EMISION', 'MONTO_TOTAL_BOB'}
        if not required <= columns:
            raise SourceError('SCHEMA_MISMATCH', 'La tabla de facturas no contiene las columnas verificadas necesarias.')
        cursor.execute(f'''
            SELECT ID_FACTURA, ID_SUSCRIPCION, PERIODO_FACTURACION, FECHA_EMISION, MONTO_TOTAL_BOB
            FROM {table}
            WHERE TO_VARCHAR(ID_CLIENTE) = %s AND FECHA_EMISION <= %s
            ORDER BY FECHA_EMISION DESC, ID_FACTURA DESC LIMIT 501
        ''', (customer_id, cutoff_value(cutoff)))
        rows, query_id = cursor.fetchall(), cursor.sfqid
    invoices = []
    for row in rows[:500]:
        if any(value is None for value in row):
            raise SourceError('INVALID_INVOICE', 'Hay facturas sin identificador, fecha, suscripción, período o importe.')
        amount = Decimal(str(row[4]))
        if not amount.is_finite() or amount < 0:
            raise SourceError('INVALID_INVOICE', 'Hay importes de factura inválidos para comparar cargos.')
        invoices.append({'id': f'SF-INVOICE:{row[0]}', 'occurredAt': iso(row[3]), 'availableAt': iso(row[3]),
                         'source': table, 'serviceId': str(row[1]), 'period': str(row[2]),
                         'chargeCode': 'INVOICE_TOTAL', 'amountMinor': int((amount * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP)), 'currency': 'BOB'})
    if len({item['id'] for item in invoices}) != len(invoices):
        raise SourceError('DUPLICATE_INVOICE_IDS', 'La fuente contiene IDs de factura repetidos.')
    warnings = ['Facturas: se compara el total emitido, no pagos ni cargos individuales; la disponibilidad se aproxima con FECHA_EMISION.']
    if len(rows) > 500: warnings.append('Se muestran las 500 facturas más recientes hasta el corte.')
    return invoices, query_id, warnings


def case_snapshot(connection, customer_id, cutoff):
    columns = verified_columns(connection)
    # An ingestion timestamp is optional and used only when it actually exists.
    availability = os.environ.get('SNOWFLAKE_AVAILABLE_AT_COLUMN')
    if availability and (not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_$]*', availability) or availability.upper() not in columns):
        raise SourceError('SCHEMA_MISMATCH', 'SNOWFLAKE_AVAILABLE_AT_COLUMN no existe en la tabla verificada.')
    availability = availability.upper() if availability else None
    available_expr = availability or 'FECHA_CREACION'
    where_available = f'AND {availability} <= %s' if availability else ''
    parameters = (customer_id, cutoff_value(cutoff), cutoff_value(cutoff)) if availability else (customer_id, cutoff_value(cutoff))
    with connection.cursor() as cursor:
        cursor.execute(f'''
            SELECT TO_VARCHAR(ID_TICKET), FECHA_CREACION, DESCRIPCION_ES, {available_expr} AS EVIDENCE_AVAILABLE_AT
            FROM {table_name()}
            WHERE TO_VARCHAR(ID_CLIENTE) = %s AND FECHA_CREACION <= %s {where_available}
              AND ID_TICKET IS NOT NULL AND DESCRIPCION_ES IS NOT NULL
            ORDER BY FECHA_CREACION DESC, ID_TICKET DESC LIMIT 201
        ''', parameters)
        rows, query_id = cursor.fetchall(), cursor.sfqid
    if not rows:
        raise SourceError('CASE_NOT_FOUND', 'No hay tickets para ese cliente hasta el corte seleccionado.', 404)
    tickets = [{'id': f'SF-TICKET:{row[0]}', 'occurredAt': iso(row[1]), 'availableAt': iso(row[3]),
                'source': table_name(), 'text': str(row[2])[:10000]} for row in rows[:200]]
    if len({t['id'] for t in tickets}) != len(tickets):
        raise SourceError('DUPLICATE_TICKET_IDS', 'La fuente contiene IDs de ticket repetidos; se necesita una clave de evidencia única.')
    invoices, invoice_query_id, warnings = invoice_evidence(connection, customer_id, cutoff)
    warnings.append('Incidencias de red y políticas comerciales no tienen una fuente verificada configurada.')
    if not invoice_query_id: warnings.append('La fuente de facturas no está configurada.')
    if not availability:
        warnings.append('Fecha de disponibilidad histórica no verificada: se usa FECHA_CREACION como aproximación; este caso no es un backtest libre de fuga.')
    if len(rows) > 200: warnings.append('Se muestran los 200 tickets más recientes hasta el corte.')
    return {'customerId': customer_id, 'tickets': tickets, 'invoices': invoices, 'incidents': [], 'policies': [],
            'source': table_name(), 'queryId': query_id, 'warnings': warnings,
            'queryIds': {'tickets': query_id, **({'invoices': invoice_query_id} if invoice_query_id else {})},
            'availability': {'tickets': 'available', 'invoices': 'available' if invoice_query_id else 'not_configured', 'incidents': 'not_configured', 'policies': 'not_configured'}}
