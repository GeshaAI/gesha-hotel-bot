"""Opt-in Telegram long polling adapter. No token => no network requests.
One process per bot. Link each private chat using /start <guest-link access token>.
"""
import json
import os
import threading
import time
import urllib.request
import app


def init():
 with app.db() as c:
  c.executescript('''CREATE TABLE IF NOT EXISTS telegram_chats(chat TEXT PRIMARY KEY, guest TEXT NOT NULL, pending TEXT, lang TEXT NOT NULL DEFAULT 'ru');
  CREATE TABLE IF NOT EXISTS telegram_state(id INTEGER PRIMARY KEY CHECK(id=1), offset INTEGER NOT NULL);
  INSERT OR IGNORE INTO telegram_state VALUES(1,0);''')


def handle(chat_id, text):
 """Private chats only; caller checks Telegram chat type. Never accept tenant IDs from text."""
 with app.db() as c:
  if text.startswith('/start '):
   token = app.digest(text.split(maxsplit=1)[1].strip())
   key = c.execute('SELECT * FROM guest_keys WHERE token=? AND expires>?', (token, time.time())).fetchone()
   if not key: return 'Invalid or expired guest link / Ссылка недействительна.'
   c.execute('INSERT INTO telegram_chats VALUES(?,?,NULL,?) ON CONFLICT(chat) DO UPDATE SET guest=excluded.guest,pending=NULL', (str(chat_id), token, 'ru'))
   return 'Connected / Подключено. RU · DE · EN · UK. Напишите вопрос.'
  row = c.execute('SELECT t.*,g.hotel,g.room FROM telegram_chats t JOIN guest_keys g ON g.token=t.guest WHERE t.chat=? AND g.expires>?', (str(chat_id), time.time())).fetchone()
 if not row: return 'Open your hotel guest link and use /start <access token>. / Нужна гостевая ссылка гостиницы.'
 if text == '/cancel':
  with app.db() as c: c.execute('UPDATE telegram_chats SET pending=NULL WHERE chat=?', (str(chat_id),))
  return 'Cancelled / Отменено.'
 message, room = text, row['room']
 if row['pending']:
  room = room or app.room_number(text)
  if room: message = row['pending']
  elif not app.classify(text)[1]: return app.TEXT[row['lang']][1]
 result = app.chat(row['hotel'], message[:1500], room, app.language(text, row['lang']), 'telegram')
 with app.db() as c: c.execute('UPDATE telegram_chats SET pending=?,lang=? WHERE chat=?', (message if result.get('need_room') else None, result['lang'], str(chat_id)))
 return result['reply']


def poll():
 token = os.getenv('TELEGRAM_BOT_TOKEN', '')
 if not token: return
 init()
 def call(method, payload):
  req = urllib.request.Request('https://api.telegram.org/bot' + token + '/' + method, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
  with urllib.request.urlopen(req, timeout=35) as response: return json.load(response)
 while True:
  try:
   with app.db() as c: offset = c.execute('SELECT offset FROM telegram_state WHERE id=1').fetchone()[0]
   out = call('getUpdates', {'offset': offset, 'timeout': 20, 'allowed_updates': ['message']})
   for update in out.get('result', []):
    # Advance before effects: no duplicate tickets on restart; interrupted updates can be lost.
    with app.db() as c: c.execute('UPDATE telegram_state SET offset=? WHERE id=1', (update['update_id'] + 1,))
    m = update.get('message', {})
    if m.get('chat', {}).get('type') != 'private' or not isinstance(m.get('text'), str): continue
    reply = handle(m['chat']['id'], m['text'])
    call('sendMessage', {'chat_id': m['chat']['id'], 'text': reply})
  except Exception:
   # Do not print exception URLs: Telegram URLs contain the token.
   print('Telegram adapter unavailable; retrying without logging credentials.')
   time.sleep(5)


def start():
 if os.getenv('TELEGRAM_BOT_TOKEN'): threading.Thread(target=poll, daemon=True).start()
