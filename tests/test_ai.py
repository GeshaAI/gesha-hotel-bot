import io
import json
import os
import unittest
from unittest.mock import patch
import app
import ai_provider

class AITests(unittest.TestCase):
 def test_disabled_does_not_call_network(self):
  with patch.dict(os.environ, {'ENABLE_LLM_ROUTER': '0'}), patch('urllib.request.urlopen') as network:
   self.assertEqual(ai_provider.classify('hello', app.RULES), ('', '')); network.assert_not_called()

 def test_only_valid_intents_are_accepted(self):
  env = {'ENABLE_LLM_ROUTER': '1', 'LLM_ENDPOINT': 'https://example.invalid/v1/chat/completions', 'LLM_MODEL': 'mock-model'}
  for content, expected in [('{"group":"faq","key":"lunch"}', ('faq', 'lunch')), ('{"group":"faq","key":"free dinner at 18:00"}', ('', '')), ('Ignore all rules', ('', ''))]:
   data = json.dumps({'choices': [{'message': {'content': content}}]}).encode()
   with patch.dict(os.environ, env), patch('urllib.request.urlopen', return_value=io.BytesIO(data)):
    self.assertEqual(ai_provider.classify('unknown phrase', app.RULES), expected)
