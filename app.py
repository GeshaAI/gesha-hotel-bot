import os, json, sqlite3, secrets, urllib.request, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
from pathlib import Path
ROOT=Path(__file__).parent
DB=ROOT/'hotel.db'
PORT=int(os.getenv('PORT','8080'))
TOKEN=os.getenv('TELEGRAM_BOT_TOKEN','')
ADMIN_KEY=os.getenv('ADMIN_KEY','change-me-before-deploy')
HOTEL=os.getenv('HOTEL_NAME','Demo Hotel')
ROOMS={'wifi':'Wi-Fi: спросите пароль у администратора.','checkin':'Время заселения уточняйте у администратора.','parking':'Парковку уточняйте у администратора.'}
def db():
 c=sqlite3.connect(DB,timeout=10); c.row_factory=sqlite3.Row; return c
def init():
 with db() as c:
  c.execute('CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, issue TEXT, channel TEXT, status TEXT DEFAULT "new", created_at TEXT DEFAULT CURRENT_TIMESTAMP)')
  c.execute('CREATE TABLE IF NOT EXISTS faq(key TEXT PRIMARY KEY, answer TEXT)')
  for k,v in ROOMS.items(): c.execute('INSERT OR IGNORE INTO faq VALUES (?,?)',(k,v))
init()
def tg(method,payload):
 if not TOKEN:return None
 try:
  r=urllib.request.Request(f'https://api.telegram.org/bot{TOKEN}/{method}',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
  return json.load(urllib.request.urlopen(r,timeout=15))
 except Exception as e: print('Telegram error:',type(e).__name__); return None
def notify(text):
 chat=os.getenv('STAFF_CHAT_ID','')
 if chat: threading.Thread(target=lambda:tg('sendMessage',{'chat_id':chat,'text':text}),daemon=True).start()
def reply(msg,room='',channel='web'):
 s=msg.lower()
 if any(w in s for w in ['сломал','сломано','не работает','broken','kaputt','defekt','ремонт','уборк','cleaning','heizung']):
  with db() as c:
   cur=c.execute('INSERT INTO tickets(room,issue,channel) VALUES(?,?,?)',(room[:32],msg[:1500],channel)); tid=cur.lastrowid
  notify(f'🛎 Заявка #{tid}\nНомер: {room or "не указан"}\n{msg[:500]}')
  return f'Заявка №{tid} передана персоналу. Если ситуация опасная или срочная, обратитесь непосредственно к администратору.'
 k='wifi' if any(x in s for x in ['wifi','wi-fi','вайф','интернет','wlan']) else 'checkin' if any(x in s for x in ['заселен','заезд','check-in','checkin','eincheck']) else 'parking' if any(x in s for x in ['парков','parking','parkplatz']) else None
 if k:
  with db() as c: return c.execute('SELECT answer FROM faq WHERE key=?',(k,)).fetchone()['answer']
 return 'Я демонстрационный помощник гостиницы. Спросите про Wi-Fi, парковку или заселение либо сообщите о неисправности.'
def poll():
 offset=0
 while True:
  out=tg('getUpdates',{'offset':offset,'timeout':20,'allowed_updates':['message']})
  if not out or not out.get('ok'): time.sleep(5); continue
  for u in out['result']:
   offset=u['update_id']+1
   m=u.get('message',{}); msg=m.get('text',''); chat=m.get('chat',{}).get('id')
   if chat and msg:
    answer=f'Добро пожаловать в {HOTEL}! Напишите вопрос или сообщите о неисправности.' if msg.startswith('/start') else reply(msg,channel='telegram')
    tg('sendMessage',{'chat_id':chat,'text':answer})
class Handler(BaseHTTPRequestHandler):
 def send(self,code,data,kind='application/json'):
  raw=json.dumps(data,ensure_ascii=False).encode() if kind=='application/json' else data
  self.send_response(code); self.send_header('Content-Type',kind+'; charset=utf-8'); self.send_header('Content-Length',str(len(raw))); self.send_header('Cache-Control','no-store'); self.end_headers(); self.wfile.write(raw)
 def body(self):
  n=int(self.headers.get('Content-Length','0'))
  if n>8192: raise ValueError('Payload too large')
  return json.loads(self.rfile.read(n))
 def authorized(self):return secrets.compare_digest(self.headers.get('X-Admin-Key',''),ADMIN_KEY)
 def do_GET(self):
  p=urlparse(self.path)
  if p.path=='/':return self.send(200,(ROOT/'index.html').read_bytes(),'text/html')
  if p.path=='/api/config':return self.send(200,{'hotel':HOTEL,'telegram_enabled':bool(TOKEN)})
  if p.path=='/api/tickets':
   if not self.authorized():return self.send(401,{'error':'Unauthorized'})
   with db() as c:return self.send(200,[dict(x) for x in c.execute('SELECT * FROM tickets ORDER BY id DESC LIMIT 100')])
  if p.path=='/api/faq':
   if not self.authorized():return self.send(401,{'error':'Unauthorized'})
   with db() as c:return self.send(200,[dict(x) for x in c.execute('SELECT * FROM faq')])
  self.send(404,{'error':'Not found'})
 def do_POST(self):
  try:b=self.body()
  except Exception:return self.send(400,{'error':'Invalid request'})
  if self.path=='/api/chat':
   msg=str(b.get('message',''))[:1500];room=str(b.get('room',''))[:32]
   if not msg.strip():return self.send(400,{'error':'Empty message'})
   return self.send(200,{'reply':reply(msg,room)})
  if self.path=='/api/faq':
   if not self.authorized():return self.send(401,{'error':'Unauthorized'})
   key=str(b.get('key',''))[:50];answer=str(b.get('answer',''))[:2000]
   if key not in ROOMS or not answer:return self.send(400,{'error':'Invalid FAQ'})
   with db() as c:c.execute('INSERT OR REPLACE INTO faq VALUES (?,?)',(key,answer))
   return self.send(200,{'ok':True})
  if self.path=='/api/tickets/status':
   if not self.authorized():return self.send(401,{'error':'Unauthorized'})
   if b.get('status') not in ['new','in_progress','done']:return self.send(400,{'error':'Invalid status'})
   with db() as c:c.execute('UPDATE tickets SET status=? WHERE id=?',(b['status'],int(b['id'])))
   return self.send(200,{'ok':True})
  self.send(404,{'error':'Not found'})
if __name__=='__main__':
 if ADMIN_KEY=='change-me-before-deploy':print('WARNING: set ADMIN_KEY before public deployment')
 if TOKEN:threading.Thread(target=poll,daemon=True).start()
 print(f'GESHA HOTEL BOT http://localhost:{PORT}')
 ThreadingHTTPServer(('0.0.0.0',PORT),Handler).serve_forever()
