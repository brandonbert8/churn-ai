"""Verify real Snowflake rows and the local PLN without invoking a language model."""
from datetime import datetime, timezone
import json
import os
from services.pln import snowflake_data


def main():
    cutoff = datetime.now(timezone.utc).isoformat()
    try:
        with snowflake_data.connect() as connection:
            catalog = snowflake_data.list_customers(connection, cutoff)
            if not catalog['customers']:
                print(json.dumps({'verified': False, 'reason': 'No hay tickets hasta el corte', 'queryId': catalog['queryId']}))
                return 1
            snapshot = snowflake_data.case_snapshot(connection, catalog['customers'][0]['customerId'], cutoff)
        from services.pln.app import AnalyzeRequest, MODEL_DIR, analyze
        result = analyze(AnalyzeRequest(text=snapshot['tickets'][0]['text'], includeEmbedding=True), authorization=f"Bearer {os.environ.get('PLN_API_TOKEN', '')}")
        print(json.dumps({
            'verified': True, 'source': snapshot['source'], 'queryId': snapshot['queryId'],
            'ticketsLoaded': len(snapshot['tickets']), 'invoicesLoaded': len(snapshot['invoices']),
            'queryIds': snapshot['queryIds'], 'modelDirectory': MODEL_DIR.name,
            'category': result['category'], 'classes': len(result['scores']),
            'embeddingDimensions': result['embedding']['dimensions'], 'warnings': snapshot['warnings'],
        }, ensure_ascii=False))
        return 0
    except snowflake_data.SourceError as error:
        print(json.dumps({'verified': False, 'code': error.code, 'reason': error.message}, ensure_ascii=False))
        return 1

if __name__ == '__main__': raise SystemExit(main())
