import json
import math
import os
import unittest
import urllib.request
import urllib.error

BASE = os.environ.get('PLN_TEST_URL', 'http://127.0.0.1:8001')

class InferenceTests(unittest.TestCase):
    def test_real_export_classification_and_embedding(self):
        body = json.dumps({'text': 'No quiero cancelar, pero me cobraron dos veces.', 'includeEmbedding': True}).encode()
        request = urllib.request.Request(BASE + '/analyze', body, {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
        self.assertEqual(len(result['scores']), 8)
        self.assertAlmostEqual(sum(result['scores'].values()), 1)
        self.assertIn(result['category'], result['scores'])
        self.assertFalse(result['productionReady'])
        self.assertFalse(result['calibrated'])
        self.assertEqual(result['embedding']['dimensions'], 768)
        self.assertEqual(len(result['embedding']['vector']), 768)
        self.assertTrue(all(math.isfinite(v) for v in result['embedding']['vector']))
        self.assertFalse(result['embedding']['semanticSearchValidated'])

    def test_empty_text_rejected(self):
        request = urllib.request.Request(BASE + '/analyze', b'{"text":"   "}', {'Content-Type':'application/json'})
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request, timeout=10)
        self.assertEqual(error.exception.code, 422)

if __name__ == '__main__':
    unittest.main()
