"""Compare the frontend catalog against independent read-only Snowflake queries."""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen
from urllib.parse import urlencode
from services.pln import snowflake_data as source

def main():
    cutoff = datetime.now(timezone.utc).isoformat()
    with urlopen('http://127.0.0.1:3000/api/customers?' + urlencode({'cutoff': cutoff}), timeout=60) as response:
        catalog = json.load(response)
    ids = [item['customerId'] for item in catalog['customers']]
    if catalog.get('mode') != 'live' or not ids:
        raise RuntimeError('El frontend no está devolviendo un catálogo live con clientes.')
    with source.connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute('SELECT CURRENT_ACCOUNT_NAME(), CURRENT_DATABASE(), CURRENT_SCHEMA(), CURRENT_ROLE()')
            account, database, schema, role = cursor.fetchone()
            cursor.execute('SELECT TO_VARCHAR(ID_CLIENTE), COUNT(*) FROM ' + source.table_name() + ' WHERE TO_VARCHAR(ID_CLIENTE) IN (' + ','.join(['%s'] * len(ids)) + ') GROUP BY ID_CLIENTE', tuple(ids))
            verified = {str(row[0]): int(row[1]) for row in cursor.fetchall()}
            client_query_id = cursor.sfqid
            cursor.execute('SELECT TABLE_SCHEMA, TABLE_NAME FROM DBT.INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME ILIKE %s ORDER BY TABLE_SCHEMA, TABLE_NAME', ('%CLIENT%',))
            customer_tables = [list(row) for row in cursor.fetchall()]
            cursor.execute('SELECT COLUMN_NAME FROM DBT.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s ORDER BY ORDINAL_POSITION', ('ORO', 'DIM_CLIENTES'))
            master_columns = [row[0] for row in cursor.fetchall()]
            master_matches = None
            if 'ID_CLIENTE' in master_columns:
                cursor.execute('SELECT TO_VARCHAR(ID_CLIENTE) FROM DBT.ORO.DIM_CLIENTES WHERE TO_VARCHAR(ID_CLIENTE) IN (' + ','.join(['%s'] * len(ids)) + ')', tuple(ids))
                master_matches = list({str(row[0]) for row in cursor.fetchall()})
        snapshot = source.case_snapshot(connection, ids[0], cutoff)
        invoices = snapshot['invoices']
        with connection.cursor() as cursor:
            invoice_table = os.environ.get('SNOWFLAKE_INVOICES_TABLE')
            cursor.execute('SELECT TO_VARCHAR(ID_FACTURA) FROM ' + invoice_table + ' WHERE TO_VARCHAR(ID_CLIENTE) = %s', (ids[0],))
            invoice_ids = {str(row[0]) for row in cursor.fetchall()}
            invoice_query_id = cursor.sfqid
    report = {
        'mode': catalog['mode'], 'checkedAt': cutoff,
        'connection': {'account': account, 'database': database, 'schema': schema, 'role': role},
        'ticketsTable': source.table_name(), 'invoicesTable': invoice_table,
        'frontendQueryId': catalog.get('queryId'), 'verificationQueryId': client_query_id,
        'displayedClientIds': ids, 'displayedClients': len(ids), 'matchedClients': len(set(ids) & verified.keys()),
        'missingClientIds': [value for value in ids if value not in verified],
        'firstClientId': ids[0], 'firstClientInvoices': [{'evidenceId': row['id'], 'sourceId': row['id'].removeprefix('SF-INVOICE:'), 'foundInSnowflake': row['id'].removeprefix('SF-INVOICE:') in invoice_ids} for row in invoices],
        'invoiceVerificationQueryId': invoice_query_id, 'customerTables': customer_tables,
        'masterColumns': master_columns, 'matchedInMaster': len(master_matches) if master_matches is not None else None,
        'missingFromMaster': [value for value in ids if value not in master_matches] if master_matches is not None else None,
    }
    Path('.mastra').mkdir(exist_ok=True)
    Path('.mastra/source-audit.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))

if __name__ == '__main__': main()
