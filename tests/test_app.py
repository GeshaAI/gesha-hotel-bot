import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
import app
import telegram_adapter

class ServerTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.tmp = tempfile.TemporaryDirectory()
  app.DB = Path(cls.tmp.name) / 'test.db'
  app.init()
  with app.db() as c:
   for hotel in ('alpha', 'beta'):
    c.execute('INSERT INTO hotels VALUES(?,?)', (hotel, json.dumps({'name': hotel, 'breakfast': {'ru': '07:00–09:00'}, 'lunch': {'ru': '12:00–14:00'}, 'checkout': {'ru': '11:00'}})))
    c.execute('INSERT INTO guest_keys VALUES(?,?,?,?)', (app.digest(hotel + '-guest'), hotel, '', time.time() + 3600))
  for hotel in ('alpha', 'beta'):
   for role in ('owner', 'manager', 'staff'): app.add_user(hotel, role, role, 'test-password-123')
  cls.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
  cls.port = cls.server.server_port
  threading.Thread(target=cls.server.serve_forever, daemon=True).start()
  cls.cookies = {}
  for hotel in ('alpha', 'beta'):
   for role in ('owner', 'manager', 'staff'):
    code, _, headers = cls.request('/api/login', {'hotel': hotel, 'name': role, 'password': 'test-password-123'})
    assert code == 200
    cls.cookies[hotel + '-' + role] = headers['Set-Cookie'].split(';')[0]
  with app.db() as c: cls.staff_id = c.execute("SELECT id FROM users WHERE hotel='alpha' AND role='staff'").fetchone()[0]

 @classmethod
 def tearDownClass(cls): cls.server.shutdown(); cls.server.server_close(); cls.tmp.cleanup()

 @classmethod
 def request(cls, path, body=None, user=None, guest=None, extra=None):
  c = http.client.HTTPConnection('127.0.0.1', cls.port)
  headers = {'Content-Type': 'application/json', 'X-Requested-With': 'gesha'}
  if user: headers['Cookie'] = cls.cookies[user]
  if guest: headers['X-Guest-Token'] = guest
  if extra: headers.update(extra)
  c.request('POST' if body is not None else 'GET', path, json.dumps(body) if body is not None else None, headers)
  r = c.getresponse(); raw = r.read(); result_headers = dict(r.getheaders())
  data = json.loads(raw) if 'application/json' in r.getheader('Content-Type', '') else raw.decode()
  code = r.status; c.close(); return code, data, result_headers

 def test_meals_and_checkout(self):
  for message, expected in [('Когда завтрак?', '07:00–09:00'), ('Во сколько обед?', '12:00–14:00'), ('Во сколько нужно освободить номер?', '11:00')]:
   status, data, _ = self.request('/api/chat', {'message': message}, guest='alpha-guest')
   self.assertEqual((status, data['reply']), (200, expected))

 def test_cold_room_and_workflow(self):
  _, data, _ = self.request('/api/chat', {'message': 'В комнате холодно'}, guest='alpha-guest')
  self.assertTrue(data['need_room'])
  _, data, _ = self.request('/api/chat', {'message': 'В комнате холодно', 'room': 'комната 12'}, guest='alpha-guest')
  tid = data['ticket_id']
  _, tickets, _ = self.request('/api/tickets', user='alpha-owner')
  self.assertTrue(any(x['id'] == tid and x['room'] == '12' and x['category'] == 'heating' for x in tickets))
  self.assertEqual(self.request('/api/tickets/status', {'id': tid, 'status': 'done'}, user='alpha-owner')[0], 400)
  self.assertEqual(self.request('/api/tickets/status', {'id': tid, 'assignee': self.staff_id}, user='alpha-owner')[0], 200)
  for status in ('accepted', 'in_progress', 'done'):
   self.assertEqual(self.request('/api/tickets/status', {'id': tid, 'status': status}, user='alpha-staff')[0], 200)
  self.assertEqual(self.request('/api/tickets/status', {'id': tid, 'priority': 'high'}, user='alpha-staff')[0], 403)

 def test_four_languages_and_no_fabricated_info(self):
  for lang, message in [('ru','Нет горячей воды'), ('de','Das Zimmer ist kalt'), ('en','The room is cold'), ('uk','У кімнаті холодно')]:
   data = self.request('/api/chat', {'message': message, 'lang': lang}, guest='alpha-guest')[1]
   self.assertEqual(data['lang'], lang); self.assertEqual(data['reply'], app.TEXT[lang][1])
  data = self.request('/api/chat', {'message': 'When is dinner?', 'lang': 'en'}, guest='alpha-guest')[1]
  self.assertEqual(data['reply'], app.TEXT['en'][0])

 def test_wifi_fault_before_faq(self):
  for message in ('Не работает интернет', 'WLAN funktioniert nicht', 'Wi-Fi not working', 'Не працює інтернет'):
   self.assertEqual(app.classify(message), ('issues', 'internet'))

 def test_help_needs_details(self):
  data = self.request('/api/chat', {'message': 'Помогите, у меня проблема', 'room': '12'}, guest='alpha-guest')[1]
  self.assertTrue(data['need_detail']); self.assertNotIn('ticket_id', data)

 def test_settings_persist_and_roles(self):
  settings = self.request('/api/settings', user='alpha-owner')[1]
  settings['services'] = {'ru': 'Проверенные услуги', 'en': 'Verified services'}
  self.assertEqual(self.request('/api/settings', {'settings': settings}, user='alpha-staff')[0], 403)
  self.assertEqual(self.request('/api/settings', {'settings': settings}, user='alpha-manager')[0], 200)
  self.assertEqual(self.request('/api/settings', user='alpha-owner')[1]['services'], settings['services'])
  self.assertEqual(self.request('/api/chat', {'message': 'Услуги'}, guest='alpha-guest')[1]['reply'], 'Проверенные услуги')

 def test_tenant_isolation(self):
  data = self.request('/api/chat', {'message': 'Сломался телевизор', 'room': '15', 'hotel': 'beta'}, guest='alpha-guest')[1]
  tid = data['ticket_id']
  for role in ('owner', 'manager', 'staff'):
   foreign = self.request('/api/tickets?hotel=alpha', user='beta-' + role)[1]
   self.assertFalse(any(x['id'] == tid for x in foreign))
   self.assertEqual(self.request('/api/tickets/status', {'id': tid, 'status': 'accepted'}, user='beta-' + role)[0], 404)
  self.assertEqual(self.request('/api/tickets/status', {'id': tid, 'status': 'accepted'}, user='alpha-staff')[0], 404)
  self.assertEqual(self.request('/api/tickets')[0], 401)
  self.assertEqual(self.request('/api/settings')[0], 401)
  self.assertEqual(self.request('/api/chat', {'message': 'hello'}, guest='invalid')[0], 401)
  with app.db() as c: beta_staff = c.execute("SELECT id FROM users WHERE hotel='beta' AND role='staff'").fetchone()[0]
  self.assertEqual(self.request('/api/tickets/status', {'id': tid, 'assignee': beta_staff}, user='alpha-owner')[0], 400)

 def test_secure_session_and_input(self):
  status, data, headers = self.request('/api/login', {'hotel': 'alpha', 'name': 'owner', 'password': 'test-password-123'})
  self.assertEqual(status, 200)
  for flag in ('HttpOnly', 'SameSite=Strict', 'Secure'): self.assertIn(flag, headers['Set-Cookie'])
  self.assertEqual(self.request('/api/settings', {'settings': {}}, user='alpha-owner', extra={'X-Requested-With': ''})[0], 403)
  self.assertEqual(self.request('/api/chat', {'message': ''}, guest='alpha-guest')[0], 400)
  self.assertEqual(self.request('/api/chat', {'message': 'x' * 1501}, guest='alpha-guest')[0], 400)
  self.assertEqual(self.request('/api/users', {'name': 'x', 'role': 'owner', 'password': 'long-password'}, user='alpha-manager')[0], 403)

 def test_guest_room_binding_and_expiry(self):
  code, link, _ = self.request('/api/guest-links', {'room': '42'}, user='alpha-owner')
  self.assertEqual(code, 201); token = link['url'].split('access=')[1]
  self.assertEqual(self.request('/api/config', guest=token)[1]['room'], '42')
  data = self.request('/api/chat', {'message': 'Сломался телевизор', 'room': '99'}, guest=token)[1]
  with app.db() as c:
   self.assertEqual(c.execute('SELECT room FROM requests WHERE id=?', (data['ticket_id'],)).fetchone()[0], '42')
   c.execute('UPDATE guest_keys SET expires=0 WHERE token=?', (app.digest(token),))
  self.assertEqual(self.request('/api/config', guest=token)[0], 401)

 def test_telegram_adapter_without_network(self):
  telegram_adapter.init()
  self.assertIn('Connected', telegram_adapter.handle(123, '/start alpha-guest'))
  self.assertEqual(telegram_adapter.handle(123, 'В комнате холодно'), app.TEXT['ru'][1])
  self.assertIn('зарегистрирована', telegram_adapter.handle(123, 'комната 25'))
  self.assertIn('недействительна', telegram_adapter.handle(456, '/start invalid'))

 def test_assets_and_no_cache(self):
  status, html, headers = self.request('/')
  self.assertEqual(status, 200); self.assertIn('data-runtime="server"', html)
  self.assertEqual(headers['Cache-Control'], 'no-store')
  self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
  for path in ('/staff','/ui.js','/style.css','/engine.js','/rules.json','/i18n.json'):
   self.assertEqual(self.request(path)[0], 200)
  self.assertEqual(self.request('/hotel.db')[0], 404)

if __name__ == '__main__': unittest.main()
