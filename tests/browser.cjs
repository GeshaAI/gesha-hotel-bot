// Run after installing playwright. Starts disposable local servers; no live accounts or services.
const {chromium}=require('playwright');
const {spawn,spawnSync}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const temp=mkdtempSync(path.join(os.tmpdir(),'gesha-test-'));
const env={...process.env,HOTEL_DB:path.join(temp,'test.db'),PORT:'8766',COOKIE_SECURE:'0',TELEGRAM_BOT_TOKEN:'',ENABLE_LLM_ROUTER:'0'};
const seed=spawnSync('python',['-c',`import app,json,time; app.init(); c=app.db(); c.execute('INSERT INTO hotels VALUES(?,?)',('test',json.dumps({'name':'Test Hotel'}))); c.execute('INSERT INTO guest_keys VALUES(?,?,?,?)',(app.digest('browser-test-token'),'test','',time.time()+3600)); c.commit(); c.close(); app.add_user('test','owner','owner','browser-password-123')`],{env,encoding:'utf8'});
if(seed.status!==0)throw Error(seed.stderr);
const staticServer=spawn('python',['-m','http.server','8765','--bind','127.0.0.1','--directory','docs'],{stdio:'ignore'});
const apiServer=spawn('python',['app.py'],{env,stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(url){for(let i=0;i<50;i++){try{if((await fetch(url)).ok)return}catch{}await wait(100)}throw Error('Server failed to start')}
async function send(page,text){await page.fill('#message',text);await page.click('#send');await page.waitForFunction(()=>!document.querySelector('#send').disabled)}
async function noOverflow(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow')}
(async()=>{
 let browser;
 try{
  await Promise.all([ready('http://127.0.0.1:8765'),ready('http://127.0.0.1:8766/api/mode')]);
  browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({viewport:{width:390,height:844}});
  const page=await ctx.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8765');await page.waitForSelector('.bubble');await noOverflow(page);
  await send(page,'Когда обед?');assert.ok((await page.locator('.bubble').last().innerText()).includes('не указана'));
  await send(page,'В комнате холодно');assert.ok((await page.locator('.bubble').last().innerText()).includes('номер комнаты'));
  await send(page,'комната 12');assert.ok((await page.locator('.bubble').last().innerText()).includes('только в этом браузере'));
  await page.click('#theme');assert.ok(await page.locator('body').evaluate(e=>e.classList.contains('dark')));
  await page.goto('http://127.0.0.1:8765/staff.html');await page.waitForSelector('.ticket');await noOverflow(page);
  await page.fill('[data-field=lunch]','12:00–14:00');await page.locator('#settingsForm button').click();await page.waitForSelector('#saved:not(:empty)');
  await page.locator('.ticket button').last().click();assert.equal(await page.locator('.ticket .badge').innerText(),'Принята');
  await page.reload();await page.waitForSelector('.ticket');assert.equal(await page.inputValue('[data-field=lunch]'),'12:00–14:00');
  await page.goto('http://127.0.0.1:8765');await page.waitForSelector('.bubble');await send(page,'Во сколько обед?');assert.equal(await page.locator('.bubble').last().innerText(),'12:00–14:00');
  for(const lang of ['de','en','uk','ru']){await page.selectOption('#lang',lang);assert.equal(await page.getAttribute('html','lang'),lang);await noOverflow(page)}
  await page.setViewportSize({width:800,height:1280});await noOverflow(page);
  console.log('PASS: demo chat, natural room clarification, settings persistence, status, four UI languages, light/dark, widths 390/800');
  // Server path must use real API and SQLite, never localStorage tickets.
  await page.goto('http://127.0.0.1:8766/#access=browser-test-token');await page.waitForSelector('.bubble');
  await send(page,'Не работает интернет');await send(page,'номер 16');assert.ok((await page.locator('.bubble').last().innerText()).includes('зарегистрирована'));
  const staff=await ctx.newPage();staff.on('pageerror',e=>errors.push(e.message));await staff.goto('http://127.0.0.1:8766/staff');
  await staff.fill('#loginHotel','test');await staff.fill('#loginName','owner');await staff.fill('#loginPassword','browser-password-123');await staff.locator('#loginForm button').click();await staff.waitForSelector('.ticket');
  assert.ok((await staff.locator('.ticket').innerText()).includes('16'));
  for(const expected of ['Принята','В работе','Выполнена']){await staff.locator('.ticket button').last().click();await staff.waitForFunction(expected=>document.querySelector('.badge').textContent===expected,expected)}
  await staff.fill('[data-field=checkout]','10:30');await staff.locator('#settingsForm button').click();await staff.waitForSelector('#saved:not(:empty)');
  await send(page,'Во сколько нужно освободить номер?');assert.equal(await page.locator('.bubble').last().innerText(),'10:30');
  await staff.click('#logout');await staff.waitForSelector('#loginForm:not([hidden])');
  assert.deepEqual(errors,[]);console.log('PASS: server login, guest ticket -> staff panel, workflow, settings -> guest answer, logout, no JS errors');
 }finally{if(browser)await browser.close();staticServer.kill();apiServer.kill();rmSync(temp,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
