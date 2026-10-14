"""GESHA HOTEL BOT v0.4.1: dependency-free pilot server; use HTTPS reverse proxy."""
import argparse
import getpass
import hashlib
import http.cookies
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).parent
DB = Path(os.environ.get('HOTEL_DB', ROOT / 'hotel.db'))
RULES = json.loads((ROOT / 'docs/rules.json').read_text())
I18N = json.loads((ROOT / 'docs/i18n.json').read_text())
LANGS = ('ru', 'de', 'en', 'uk')
ROLES = ('staff', 'manager', 'owner')
FIELDS = ('name', 'logo', 'address', 'reception', 'checkin', 'checkout', 'breakfast', 'lunch', 'dinner', 'wifi', 'parking', 'services', 'shop', 'taxi', 'information')
STATUSES = ('new', 'accepted', 'in_progress', 'done')
TEXT = {
 'ru': ['Информация не указана. Уточните у администратора.', 'Укажите номер комнаты.', 'Опишите, пожалуйста, что случилось.', 'Заявка №{id} зарегистрирована.', 'Уточните вопрос: питание, выезд, Wi-Fi, услуги или неисправность?'],
 'de': ['Diese Information fehlt. Bitte fragen Sie an der Rezeption.', 'Bitte nennen Sie Ihre Zimmernummer.', 'Bitte beschreiben Sie das Problem.', 'Anfrage Nr. {id} wurde registriert.', 'Bitte präzisieren: Mahlzeiten, Check-out, WLAN, Service oder ein Defekt?'],
 'en': ['This information is not provided. Please ask reception.', 'Please provide your room number.', 'Please describe the problem.', 'Request #{id} has been registered.', 'Please clarify: meals, check-out, Wi-Fi, services or a fault?'],
 'uk': ['Інформацію не вказано. Уточніть в адміністратора.', 'Вкажіть номер кімнати.', 'Опишіть, будь ласка, що сталося.', 'Заявку №{id} зареєстровано.', 'Уточніть запитання: харчування, виїзд, Wi-Fi, послуги чи несправність?']
}


def db():
 c = sqlite3.connect(DB, timeout=10)
 c.row_factory = sqlite3.Row
 c.execute('PRAGMA foreign_keys=ON')
 return c


def init():
 with db() as c:
  # New tables deliberately leave legacy prototype tickets/FAQ untouched.
  c.executescript('''
  CREATE TABLE IF NOT EXISTS hotels(id TEXT PRIMARY KEY, settings TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, hotel TEXT NOT NULL REFERENCES hotels(id), name TEXT NOT NULL, role TEXT NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL, UNIQUE(hotel,name));
  CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(id), expires REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS guest_keys(token TEXT PRIMARY KEY, hotel TEXT NOT NULL REFERENCES hotels(id), room TEXT NOT NULL, expires REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, hotel TEXT NOT NULL REFERENCES hotels(id), room TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, priority TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')), status TEXT NOT NULL DEFAULT 'new', assignee TEXT REFERENCES users(id), channel TEXT NOT NULL DEFAULT 'web');
  CREATE INDEX IF NOT EXISTS requests_hotel ON requests(hotel,created_at);
  CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires REAL NOT NULL);
  ''')


def digest(value):
 return hashlib.sha256(value.encode()).hexdigest()


def password_hash(password, salt):
 return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()


def add_user(hotel, name, role, password):
 if role not in ROLES or len(password) < 12 or not name.strip():
  raise ValueError('Role must be staff/manager/owner; password must contain at least 12 characters')
 salt = secrets.token_hex(16)
 with db() as c:
  c.execute('INSERT INTO users VALUES(?,?,?,?,?,?)', (secrets.token_hex(12), hotel, name, role, salt, password_hash(password, salt)))


def classify(message):
 for group in ('guards', 'issues', 'faq'):
  for key, pattern in RULES[group]:
   if re.search(pattern, message, re.I):
    return group, key
 return '', ''


def language(message, fallback='ru'):
 if re.search('[іїєґ]|кімнат|будь ласка', message, re.I): return 'uk'
 if re.search('[а-яё]', message, re.I): return 'ru'
 if re.search(r'\b(wann|zimmer|bitte|ich|nicht|heizung|frühstück|mittagessen|auschecken|kalt|wlan|wasser|handtücher)\b', message, re.I): return 'de'
 if re.search(r'\b(when|what|room|cold|please|help|breakfast|lunch|checkout|broken|water|towels)\b', message, re.I): return 'en'
 return fallback if fallback in LANGS else 'ru'


def room_number(value):
 value = unicodedata.normalize('NFKC', str(value))
 match = re.fullmatch(r'\s*(?:(?:комната|комнате|номер|кімната|кімнаті|room|zimmer)\s*)?(?:№|No\.?)?\s*([\w-]{1,10})\s*[.!]?\s*', value, re.I)
 return match[1] if match and re.search(r'[0-9]', match[1]) else ''


def short_id(value):
 return re.sub('[^A-Za-z0-9]', '', str(value))[-8:].upper()


def chat(hotel, message, room='', lang='ru', channel='web'):
 lang = language(message, lang)
 texts = TEXT[lang]
 group, key = classify(message)
 if not group:
  import ai_provider
  group, key = ai_provider.classify(message, RULES)
 with db() as c:
  config = json.loads(c.execute('SELECT settings FROM hotels WHERE id=?', (hotel,)).fetchone()[0])
  if group == 'guards':
   return {'reply': I18N[lang][key], 'lang': lang, 'need_detail': True}
  if group == 'issues':
   if key == 'help': return {'reply': texts[2], 'lang': lang, 'need_detail': True}
   room = room_number(room)
   if not room: return {'reply': texts[1], 'need_room': True, 'lang': lang}
   tid = secrets.token_hex(8).upper()
   c.execute('INSERT INTO requests(id,hotel,room,description,category,priority,channel) VALUES(?,?,?,?,?,?,?)', (tid, hotel, room, message, key, 'normal', channel))
   return {'reply': I18N[lang]['ticket'].format(id=short_id(tid), room=room, category=I18N[lang][key]), 'ticket_id': tid, 'room': room, 'category': key, 'status': 'new', 'lang': lang}
  if group == 'faq':
   value = config.get(key, {})
   return {'reply': value.get(lang) or texts[0] if isinstance(value, dict) else texts[0], 'lang': lang}
  return {'reply': texts[4], 'lang': lang}


class APIError(Exception):
 def __init__(self, status, message): self.status, self.message = status, message


class Handler(BaseHTTPRequestHandler):
 def log_message(self, *_): pass  # URLs may contain guest metadata; do not log them.

 def send(self, code, data, kind='application/json', cookie=None):
  raw = json.dumps(data, ensure_ascii=False).encode() if kind == 'application/json' else data
  self.send_response(code)
  for key, value in {'Content-Type': kind + '; charset=utf-8', 'Content-Length': str(len(raw)), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' https: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}.items(): self.send_header(key, value)
  if cookie: self.send_header('Set-Cookie', cookie)
  self.end_headers()
  self.wfile.write(raw)

 def body(self):
  if self.headers.get('Content-Type', '').split(';')[0] != 'application/json': raise APIError(415, 'JSON required')
  try:
   n = int(self.headers.get('Content-Length', '0'))
   if not 0 < n <= 32768: raise ValueError()
   value = json.loads(self.rfile.read(n))
   if not isinstance(value, dict): raise ValueError()
   return value
  except (ValueError, UnicodeError): raise APIError(400, 'Invalid JSON body')

 def user(self):
  cookie = http.cookies.SimpleCookie()
  try: cookie.load(self.headers.get('Cookie', ''))
  except http.cookies.CookieError: raise APIError(401, 'Sign in required')
  token = cookie.get('session')
  with db() as c:
   user = c.execute('SELECT u.* FROM users u JOIN sessions s ON s.user=u.id WHERE s.token=? AND s.expires>?', (digest(token.value if token else ''), time.time())).fetchone()
  if not user: raise APIError(401, 'Sign in required')
  return dict(user)

 def manager(self):
  user = self.user()
  if user['role'] not in ('manager', 'owner'): raise APIError(403, 'Manager role required')
  return user

 def guest(self):
  with db() as c:
   key = c.execute('SELECT * FROM guest_keys WHERE token=? AND expires>?', (digest(self.headers.get('X-Guest-Token', '')), time.time())).fetchone()
  if not key: raise APIError(401, 'Valid guest link required')
  return dict(key)

 def limit(self, key, maximum):
  now = time.time()
  with db() as c:
   c.execute('DELETE FROM rate_limits WHERE expires<?', (now,))
   c.execute('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1', (key, now + 60))
   count = c.execute('SELECT count FROM rate_limits WHERE key=?', (key,)).fetchone()[0]
  if count > maximum: raise APIError(429, 'Too many requests; try again in a minute')

 def do_GET(self): self.dispatch(False)
 def do_POST(self): self.dispatch(True)

 def dispatch(self, post):
  try: self.route(post)
  except APIError as e: self.send(e.status, {'error': e.message})
  except (KeyError, TypeError, ValueError): self.send(400, {'error': 'Invalid fields'})
  except sqlite3.Error: self.send(500, {'error': 'Database operation failed'})

 def route(self, post):
  path = urlparse(self.path).path
  if not post:
   files = {'/': ('index.html', 'text/html'), '/staff': ('staff.html', 'text/html'), '/ui.js': ('ui.js', 'text/javascript'), '/style.css': ('style.css', 'text/css'), '/engine.js': ('engine.js', 'text/javascript'), '/rules.json': ('rules.json', 'application/json'), '/i18n.json': ('i18n.json', 'application/json')}
   if path in files:
    file, kind = files[path]
    raw = (ROOT / 'docs' / file).read_bytes()
    if kind == 'text/html': raw = raw.replace(b'<body ', b'<body data-runtime="server" ')
    return self.send(200, raw, kind if kind != 'application/json' else 'text/plain')
   if path == '/api/mode': return self.send(200, {'mode': 'server', 'version': RULES['version']})
   if path == '/api/config':
    key = self.guest()
    with db() as c: settings = json.loads(c.execute('SELECT settings FROM hotels WHERE id=?', (key['hotel'],)).fetchone()[0])
    return self.send(200, {'settings': settings, 'room': key['room']})
   if path == '/api/me':
    u = self.user()
    return self.send(200, {k: u[k] for k in ('id', 'hotel', 'name', 'role')})
   if path == '/api/settings':
    u = self.manager()
    with db() as c: settings = json.loads(c.execute('SELECT settings FROM hotels WHERE id=?', (u['hotel'],)).fetchone()[0])
    return self.send(200, settings)
   if path == '/api/users':
    u = self.user()
    with db() as c: rows = [dict(x) for x in c.execute('SELECT id,name,role FROM users WHERE hotel=?', (u['hotel'],))]
    return self.send(200, rows)
   if path == '/api/tickets':
    u = self.user()
    with db() as c:
     sql = 'SELECT * FROM requests WHERE hotel=?'
     args = [u['hotel']]
     if u['role'] == 'staff': sql += ' AND assignee=?'; args.append(u['id'])
     rows = [dict(x) for x in c.execute(sql + ' ORDER BY created_at DESC LIMIT 500', args)]
    return self.send(200, rows)
   raise APIError(404, 'Not found')
  # JSON + custom header prevent cross-site form/CSRF requests; no CORS enabled.
  if self.headers.get('X-Requested-With') != 'gesha': raise APIError(403, 'Request header required')
  b = self.body()
  if path == '/api/login':
   self.limit('login:' + self.client_address[0], 10)
   with db() as c:
    u = c.execute('SELECT * FROM users WHERE hotel=? AND name=?', (str(b.get('hotel', '')), str(b.get('name', '')))).fetchone()
    candidate = password_hash(str(b.get('password', ''))[:256], u['salt'] if u else '00' * 16)
    if not u or not secrets.compare_digest(candidate, u['password']): raise APIError(401, 'Invalid credentials')
    token = secrets.token_urlsafe(32)
    c.execute('DELETE FROM sessions WHERE expires<?', (time.time(),))
    c.execute('INSERT INTO sessions VALUES(?,?,?)', (digest(token), u['id'], time.time() + 28800))
   secure = '; Secure' if os.getenv('COOKIE_SECURE', '1') == '1' else ''
   return self.send(200, {'ok': True}, cookie='session=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800' + secure)
  if path == '/api/logout':
   u = self.user()
   cookie = http.cookies.SimpleCookie(self.headers.get('Cookie', ''))
   with db() as c: c.execute('DELETE FROM sessions WHERE token=?', (digest(cookie['session'].value),))
   return self.send(200, {'ok': True}, cookie='session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
  if path == '/api/chat':
   key = self.guest()
   self.limit('chat:' + key['token'], 30)
   message = str(b.get('message', '')).strip()
   if not 0 < len(message) <= 1500: raise APIError(400, 'Message must contain 1–1500 characters')
   return self.send(200, chat(key['hotel'], message, key['room'] or str(b.get('room', '')), str(b.get('lang', 'ru'))))
  if path == '/api/settings':
   u = self.manager()
   settings = b.get('settings')
   if not isinstance(settings, dict) or set(settings) - set(FIELDS) - {'languages'}: raise APIError(400, 'Invalid settings')
   for k, v in settings.items():
    if k == 'languages':
     if not isinstance(v, list) or not v or any(x not in LANGS for x in v): raise APIError(400, 'Invalid languages')
    elif k in ('name', 'logo', 'address'):
     if not isinstance(v, str) or len(v) > 500: raise APIError(400, 'Invalid text')
     if k == 'logo' and v and not v.startswith('https://'): raise APIError(400, 'Logo must use HTTPS')
    elif not isinstance(v, dict) or any(l not in LANGS or not isinstance(t, str) or len(t) > 2000 for l, t in v.items()): raise APIError(400, 'Invalid translations')
   with db() as c: c.execute('UPDATE hotels SET settings=? WHERE id=?', (json.dumps(settings), u['hotel']))
   return self.send(200, {'ok': True})
  if path == '/api/tickets/status':
   u = self.user()
   with db() as c:
    t = c.execute('SELECT * FROM requests WHERE id=? AND hotel=?', (str(b.get('id', '')), u['hotel'])).fetchone()
    if not t or (u['role'] == 'staff' and t['assignee'] != u['id']): raise APIError(404, 'Request not found')
    status = b.get('status', t['status'])
    if status not in STATUSES or STATUSES.index(status) not in (STATUSES.index(t['status']), STATUSES.index(t['status']) + 1): raise APIError(400, 'Use the next status in the workflow')
    assignee = b.get('assignee', t['assignee']) or None
    priority = b.get('priority', t['priority'])
    if u['role'] == 'staff' and (assignee != t['assignee'] or priority != t['priority']): raise APIError(403, 'Manager role required')
    if priority not in ('low', 'normal', 'high'): raise APIError(400, 'Invalid priority')
    if assignee and not c.execute('SELECT 1 FROM users WHERE id=? AND hotel=?', (assignee, u['hotel'])).fetchone(): raise APIError(400, 'Invalid assignee')
    c.execute('UPDATE requests SET status=?,assignee=?,priority=? WHERE id=? AND hotel=?', (status, assignee, priority, t['id'], u['hotel']))
   return self.send(200, {'ok': True})
  if path == '/api/users':
   u = self.user()
   if u['role'] != 'owner': raise APIError(403, 'Owner role required')
   add_user(u['hotel'], str(b['name']), str(b['role']), str(b['password']))
   return self.send(201, {'ok': True})
  if path == '/api/guest-links':
   u = self.manager()
   room = room_number(str(b.get('room', '')))
   if b.get('room') and not room: raise APIError(400, 'Invalid room')
   token = secrets.token_urlsafe(32)
   with db() as c:
    c.execute('DELETE FROM guest_keys WHERE expires<?', (time.time(),))
    c.execute('INSERT INTO guest_keys VALUES(?,?,?,?)', (digest(token), u['hotel'], room, time.time() + 86400 * 7))
   return self.send(201, {'url': '/#access=' + token, 'expires_in_days': 7})
  raise APIError(404, 'Not found')


def main():
 parser = argparse.ArgumentParser()
 sub = parser.add_subparsers(dest='command')
 setup = sub.add_parser('init-hotel')
 setup.add_argument('hotel'); setup.add_argument('name'); setup.add_argument('owner')
 args = parser.parse_args()
 init()
 if args.command == 'init-hotel':
  password = getpass.getpass('Owner password (12+ characters): ')
  if len(password) < 12: raise SystemExit('Password too short')
  with db() as c: c.execute('INSERT INTO hotels VALUES(?,?)', (args.hotel, json.dumps({'name': args.name, 'languages': list(LANGS)})))
  add_user(args.hotel, args.owner, 'owner', password)
  print('Hotel and owner created. Start server; sign in at /staff.')
 else:
  import telegram_adapter
  telegram_adapter.start()
  print('GESHA HOTEL BOT v0.4.1; bind 127.0.0.1 by default; HTTPS proxy required for production cookies.')
  ThreadingHTTPServer((os.getenv('HOST', '127.0.0.1'), int(os.getenv('PORT', '8080'))), Handler).serve_forever()


if __name__ == '__main__':
 import sys
 sys.modules['app'] = sys.modules[__name__]
 main()
