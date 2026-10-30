from datetime import datetime
import os
import unittest
from unittest.mock import patch
from services.pln import customer_ranking as ranking
from services.pln import snowflake_data as source


class Cursor:
    def __init__(self, connection):
        self.connection = connection
        self.sfqid = 'ranking-query-test'
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def execute(self, sql, params):
        self.sql, self.params = sql, params
        self.connection.calls.append((sql, params))
        return self
    def fetchall(self):
        if 'INFORMATION_SCHEMA' in self.sql:
            names = self.connection.ticket_columns if self.params[1] == 'STG_SOPORTE_TICKETS' else self.connection.customer_columns
            return [(name,) for name in names]
        return self.connection.rows
    def fetchone(self): return (datetime(2024, 12, 1),)


class Connection:
    ticket_columns = {'ID_CLIENTE', 'ID_TICKET', 'FECHA_CREACION', 'DESCRIPCION_ES', 'CATEGORIA'}
    customer_columns = {'ID_CLIENTE', 'CHURN', 'FECHA_CHURN'}
    def __init__(self):
        self.calls = []
        self.rows = [('CLI-001', None, 8, 5, datetime(2024, 12, 1), 0, 60)]
    def cursor(self): return Cursor(self)


class CustomerRankingTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {'SNOWFLAKE_TICKETS_TABLE': 'DBT.BRONCE.STG_SOPORTE_TICKETS', 'SNOWFLAKE_CUSTOMERS_TABLE': 'DBT.ORO.DIM_CLIENTES', 'SNOWFLAKE_SOURCE_TIMEZONE': 'UTC', 'SNOWFLAKE_AVAILABLE_AT_COLUMN': ''})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_global_ranking_preserves_missing_names_and_probabilities(self):
        connection = Connection()
        result = ranking.rank_customers(connection, '2026-10-22T00:00:00Z')
        row = result['customers'][0]
        self.assertEqual((row['ticketCount'], row['complaintCount']), (8, 5))
        self.assertIsNone(row['customerName'])
        self.assertIsNone(row['churnProbability'])
        self.assertEqual(result['nameAvailability'], 'not_configured')
        self.assertEqual(result['probability']['status'], 'unavailable')
        self.assertEqual(result['totalEligible'], 60)
        self.assertEqual(result['queryId'], 'ranking-query-test')
        self.assertTrue(any('antigua' in warning for warning in result['warnings']))
        sql, params = connection.calls[-2]
        self.assertIn('COUNT(DISTINCT t.ID_TICKET)', sql)
        self.assertLess(sql.index('GROUP BY'), sql.index('LIMIT'))
        self.assertIn('ORDER BY COMPLAINT_COUNT DESC', sql)
        self.assertEqual(sql.count('%s'), len(params))
        self.assertEqual(params[-2:], (1, 10))

    def test_period_and_metric_are_bound_and_active_filter_can_be_disabled(self):
        connection = Connection()
        ranking.rank_customers(connection, '2024-12-02T00:00:00Z', limit=7, metric='tickets', min_tickets=3, lookback_days=30, active_only=False)
        sql, params = connection.calls[-2]
        self.assertIn('ORDER BY TICKET_COUNT DESC', sql)
        self.assertNotIn('AND (TRY_TO_NUMBER', sql)
        self.assertEqual(sql.count('%s'), len(params))
        self.assertEqual(params[-2:], (3, 7))
        self.assertEqual(params[2], datetime(2024, 11, 2))

    def test_schema_rejects_missing_category_for_complaint_ranking(self):
        connection = Connection()
        connection.ticket_columns = connection.ticket_columns - {'CATEGORIA'}
        with self.assertRaises(source.SourceError):
            ranking.rank_customers(connection, '2026-10-22T00:00:00Z')

    def test_limits_identifiers_and_availability_are_validated(self):
        for limit in (0, 51):
            with self.assertRaises(source.SourceError):
                ranking.rank_customers(Connection(), '2026-10-22T00:00:00Z', limit=limit)
        with patch.dict(os.environ, {'SNOWFLAKE_CUSTOMERS_TABLE': 'DBT.ORO.X; DROP TABLE X'}):
            with self.assertRaises(source.SourceError):
                ranking.rank_customers(Connection(), '2026-10-22T00:00:00Z')
        with patch.dict(os.environ, {'SNOWFLAKE_AVAILABLE_AT_COLUMN': 'UNVERIFIED'}):
            with self.assertRaises(source.SourceError):
                ranking.rank_customers(Connection(), '2026-10-22T00:00:00Z')

    def test_available_name_is_read_from_verified_column(self):
        connection = Connection()
        connection.customer_columns = connection.customer_columns | {'NOMBRE_COMPLETO'}
        connection.rows = [('CLI-001', 'Nombre de prueba', 8, 5, datetime(2024, 12, 1), 0, 1)]
        result = ranking.rank_customers(connection, '2026-10-22T00:00:00Z')
        self.assertEqual(result['customers'][0]['customerName'], 'Nombre de prueba')
        self.assertIn('c.NOMBRE_COMPLETO', connection.calls[-2][0])


if __name__ == '__main__': unittest.main()
