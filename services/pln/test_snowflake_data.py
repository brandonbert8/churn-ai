from datetime import datetime, timezone
import os
import unittest
from unittest.mock import patch
from services.pln import snowflake_data as source

COLUMNS = ['ID_CLIENTE', 'ID_TICKET', 'FECHA_CREACION', 'DESCRIPCION_ES', 'FECHA_INGESTA']

class Cursor:
    def __init__(self, connection): self.connection, self.sfqid = connection, 'query-test-1'
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def execute(self, sql, params):
        self.connection.calls.append((sql, params))
        self.sql = sql
        return self
    def fetchall(self):
        if 'INFORMATION_SCHEMA' in self.sql: return [(name,) for name in COLUMNS]
        return self.connection.rows

class Connection:
    def __init__(self, rows): self.rows, self.calls = rows, []
    def cursor(self): return Cursor(self)

class SnowflakeTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {'SNOWFLAKE_TICKETS_TABLE': 'DBT.BRONCE.STG_SOPORTE_TICKETS', 'SNOWFLAKE_SOURCE_TIMEZONE': 'UTC', 'SNOWFLAKE_AVAILABLE_AT_COLUMN': '', 'SNOWFLAKE_INVOICES_TABLE': ''})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_snapshot_is_real_source_bound_and_missing_sources_explicit(self):
        stamp = datetime(2026, 10, 18)
        connection = Connection([('T1', stamp, 'No quiero cancelar', stamp)])
        result = source.case_snapshot(connection, "abc' OR 1=1 --", '2026-10-20T23:59:00Z')
        sql, parameters = connection.calls[-1]
        self.assertNotIn("abc'", sql)
        self.assertEqual(parameters[0], "abc' OR 1=1 --")
        self.assertTrue(sql.strip().startswith('SELECT'))
        self.assertEqual(result['tickets'][0]['source'], 'DBT.BRONCE.STG_SOPORTE_TICKETS')
        self.assertEqual(result['tickets'][0]['id'], 'SF-TICKET:T1')
        self.assertEqual(result['availability']['invoices'], 'not_configured')
        self.assertEqual(result['policies'], [])
        self.assertTrue(any('no verificada' in warning for warning in result['warnings']))

    def test_ingestion_column_must_exist_and_adds_cutoff_parameter(self):
        stamp = datetime(2026, 10, 18, tzinfo=timezone.utc)
        connection = Connection([('T1', stamp, 'Texto', stamp)])
        with patch.dict(os.environ, {'SNOWFLAKE_AVAILABLE_AT_COLUMN': 'FECHA_INGESTA'}):
            source.case_snapshot(connection, '42', '2026-10-20T23:59:00Z')
            self.assertIn('AND FECHA_INGESTA <= %s', connection.calls[-1][0])
            self.assertEqual(len(connection.calls[-1][1]), 3)
        with patch.dict(os.environ, {'SNOWFLAKE_AVAILABLE_AT_COLUMN': 'UNKNOWN_COLUMN'}):
            with self.assertRaises(source.SourceError): source.case_snapshot(connection, '42', '2026-10-20T23:59:00Z')

    def test_identifiers_cannot_inject_sql(self):
        with patch.dict(os.environ, {'SNOWFLAKE_TICKETS_TABLE': 'DBT.BRONCE.X; DROP TABLE X'}):
            with self.assertRaises(source.SourceError): source.table_name()

    def test_invoice_amounts_use_decimal_rounding_and_bound_customer(self):
        from unittest.mock import MagicMock
        cursor = MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.sfqid = 'invoice-query'
        cursor.fetchall.side_effect = [
            [(name,) for name in ['ID_FACTURA', 'ID_CLIENTE', 'ID_SUSCRIPCION', 'PERIODO_FACTURACION', 'FECHA_EMISION', 'MONTO_TOTAL_BOB']],
            [('F1', 'S1', '2026-10', datetime(2026, 10, 1), 10.075)],
        ]
        connection = MagicMock()
        connection.cursor.return_value = cursor
        with patch.dict(os.environ, {'SNOWFLAKE_INVOICES_TABLE': 'DBT.ORO.FCT_FACTURACION'}):
            rows, query_id, warnings = source.invoice_evidence(connection, "42'", '2026-10-20T23:59:00Z')
        self.assertEqual(rows[0]['amountMinor'], 1008)
        self.assertEqual(rows[0]['id'], 'SF-INVOICE:F1')
        self.assertEqual(query_id, 'invoice-query')
        sql, params = cursor.execute.call_args.args
        self.assertNotIn("42'", sql)
        self.assertEqual(params[0], "42'")
        self.assertTrue(warnings)

    def test_empty_case_and_duplicate_keys_fail_instead_of_demo_fallback(self):
        with self.assertRaises(source.SourceError) as result:
            source.case_snapshot(Connection([]), '42', '2026-10-20T23:59:00Z')
        self.assertEqual(result.exception.code, 'CASE_NOT_FOUND')
        stamp = datetime(2026, 10, 18)
        connection = Connection([('T1', stamp, 'A', stamp), ('T1', stamp, 'B', stamp)])
        with self.assertRaises(source.SourceError) as result:
            source.case_snapshot(connection, '42', '2026-10-20T23:59:00Z')
        self.assertEqual(result.exception.code, 'DUPLICATE_TICKET_IDS')

    def test_customer_catalog_uses_bound_prefix_and_readonly_query(self):
        connection = Connection([('42', 3, datetime(2026, 10, 18))])
        result = source.list_customers(connection, '2026-10-20T23:59:00Z', '4')
        self.assertEqual(result['customers'][0]['customerId'], '42')
        self.assertEqual(connection.calls[-1][1][1], '4')
        self.assertIn('LIMIT 25', connection.calls[-1][0])

if __name__ == '__main__': unittest.main()
