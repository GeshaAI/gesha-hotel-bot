// Run after installing playwright. Starts disposable local servers; no live accounts or services.
const {chromium}=require('playwright');
const {spawn,spawnSync}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const temp=mkdtempSync(path.join(os.tmpdir(),'gesha-test-'));
const env={...process.env,HOTEL_DB:path.join(temp,'test.db'),PORT:'8766',COOKIE_SECURE:'0',TELEGRAM_BOT_TOKEN:'',ENABLE_LLM_ROUTER:'0'};
const seed=spawnSync('python',['-c',`import app,json,time; app.init(); c=app.db(); c.execute('INSERT INTO hotels VALUES(?,?)',('test',json.dumps({'name':'Test Hotel'}))); c.execute('INSERT INTO guest_keys VALUES(?,?,?,?)',(app.digest('browser-test-token'),'test','',time.time()+3600)); [c.execute('INSERT INTO guest_keys VALUES(?,?,?,?)',(app.digest('width-'+str(w)),'test','',time.time()+3600)) for w in [360,390,412,800]]; c.execute('INSERT INTO guest_keys VALUES(?,?,?,?)',(app.digest('bound-test'),'test','42',time.time()+3600)); c.commit(); c.close(); app.add_user('test','owner','owner','browser-password-123')`],{env,encoding:'utf8'});
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
  // v0.4.1 regression matrix: real DOM entry, touch emulation, both storage modes.
  for(const width of [360,390,412,800]) {
   for(const mode of ['demo','server']) {
    const mobile=await browser.newContext({viewport:{width,height:844},isMobile:true,hasTouch:true});
    const guest=await mobile.newPage();guest.on('pageerror',e=>errors.push(e.message));
    if(mode==='server' && width===360) {
     await guest.route('**/api/config',async route=>{await wait(800);await route.continue()});
    }
    await guest.goto(mode==='demo'?'http://127.0.0.1:8765':`http://127.0.0.1:8766/#access=width-${width}`);
    // Enter while /api/config is pending as well as after initialization.
    await guest.fill('#room','8');await guest.waitForSelector('.bubble');
    assert.equal(await guest.inputValue('#room'),'8','initialization must preserve typed room');
    await guest.selectOption('#lang','de');await guest.selectOption('#lang','ru');
    assert.equal(await guest.inputValue('#room'),'8','language changes must preserve room');
    await send(guest,'Не работает отопление');
    const confirmation=guest.locator('.bubble').last();const fullId=await confirmation.getAttribute('data-ticket-id');
    assert.ok(fullId);assert.ok((await confirmation.innerText()).includes('Комната 8'));
    assert.ok(!(await confirmation.innerText()).includes(fullId),'only short ID displayed');
    assert.ok(!(await confirmation.innerText()).includes('Укажите номер'));
    if(process.env.QA_SCREENSHOTS && mode==='demo' && width===390)await guest.screenshot({path:`${process.env.QA_SCREENSHOTS}/confirmation-390.png`,fullPage:true});
    if(mode==='demo'){
     assert.ok((await confirmation.innerText()).includes('Персоналу не отправлена'));
     assert.equal(await guest.evaluate(id=>JSON.parse(localStorage.getItem('gesha-hotel-demo-v04')).tickets.find(t=>t.id===id).room,fullId),'8');
    }else{
     const unauthorized=await mobile.request.get('http://127.0.0.1:8766/api/tickets',{headers:{'X-Guest-Token':`width-${width}`}});assert.equal(unauthorized.status(),401);
    }
    await guest.fill('#room','');await send(guest,'Батареи не греют');
    assert.ok((await guest.locator('.bubble').last().innerText()).includes('Укажите номер комнаты'));
    await send(guest,'комната 9');assert.ok((await guest.locator('.bubble').last().innerText()).includes('Комната 9'));
    await send(guest,'Во сколько кормят?');assert.ok((await guest.locator('.bubble').last().innerText()).includes('завтрак, обед или ужин'));
    await send(guest,'Можно ли выехать позже?');assert.ok((await guest.locator('.bubble').last().innerText()).includes('согласовать'));
    for(const language of ['de','en','uk','ru']){await guest.selectOption('#lang',language);assert.equal(await guest.inputValue('#room'),'9');await noOverflow(guest)}
    for(let i=0;i<6;i++)await send(guest,'Какой пароль Wi-Fi?');
    await guest.waitForFunction(()=>{const c=document.querySelector('#chat');return c.scrollHeight-c.clientHeight-c.scrollTop<3});
    const chatBox=await guest.locator('#chat').boundingBox();const formBox=await guest.locator('#chatForm').boundingBox();
    assert.ok(chatBox.y+chatBox.height<=formBox.y+1,'composer does not overlap chat');
    const touch=await guest.locator('#send').boundingBox();assert.ok(touch.height>=44&&touch.width>=44);
    await noOverflow(guest);
    await guest.setViewportSize({width,height:460});await guest.focus('#message');await noOverflow(guest);
    const reducedChat=await guest.locator('#chat').boundingBox();const reducedForm=await guest.locator('#chatForm').boundingBox();assert.ok(reducedChat.y+reducedChat.height<=reducedForm.y+1);
    await guest.setViewportSize({width,height:844});await guest.click('#theme');await noOverflow(guest);
    if(process.env.QA_SCREENSHOTS && mode==='demo') {await guest.screenshot({path:`${process.env.QA_SCREENSHOTS}/chat-${width}.png`,fullPage:true});}
    await mobile.close();console.log(`PASS: ${mode} ${width}px room 8 / empty room / languages / short ID / scroll / composer / touch targets`);
   }
  }
  // Editing feedback, active-tab refresh and migration of v0.4 browser data.
  const demo=await browser.newContext({viewport:{width:360,height:800}});
  await demo.addInitScript(()=>{
   if(!localStorage.getItem('gesha-hotel-demo-v04'))localStorage.setItem('gesha-hotel-demo-v04',JSON.stringify({settings:{name:'Existing hotel',languages:['ru','de','en','uk'],wifi:{ru:'Existing Wi-Fi'}},tickets:[{id:'OLD-FULL-ID-123456789',room:'8',description:'Existing request',category:'heating',priority:'normal',status:'new',created_at:'2026-10-14T10:00:00Z',assignee:null}]}));
  });
  const admin=await demo.newPage();await admin.goto('http://127.0.0.1:8765/staff.html');await admin.waitForSelector('.ticket');
  assert.equal(await admin.locator('.ticket').getAttribute('data-ticket-id'),'OLD-FULL-ID-123456789');
  assert.ok((await admin.locator('#settingsProgress').innerText()).includes('1 из 9'));
  await admin.click('#missingToggle');assert.ok(await admin.locator('[data-field=wifi]').isHidden());
  await admin.locator('[data-field=breakfast]').pressSequentially('07:00–09:00');assert.equal(await admin.inputValue('[data-field=breakfast]'),'07:00–09:00');assert.ok(await admin.locator('[data-field=breakfast]').isVisible());await admin.fill('[data-field=breakfast]','');
  await admin.click('#missingToggle');assert.ok(await admin.locator('[data-field=wifi]').isVisible());
  const guest=await demo.newPage();await guest.goto('http://127.0.0.1:8765');await guest.waitForSelector('.bubble');
  await admin.fill('[data-field=lunch]','12:45–14:15');assert.ok((await admin.locator('#settingsProgress').innerText()).includes('2 из 9'));
  await admin.locator('#settingsForm button').click();await admin.waitForSelector('#saved:not(:empty)');
  await send(guest,'Когда обед?');assert.equal(await guest.locator('.bubble').last().innerText(),'12:45–14:15');
  await admin.reload();await admin.waitForSelector('.ticket');assert.equal(await admin.inputValue('[data-field=lunch]'),'12:45–14:15');
  await admin.selectOption('#filter','done');assert.equal(await admin.locator('.ticket').count(),0);
  await admin.selectOption('#filter','new');assert.equal(await admin.locator('.ticket').count(),1);
  await noOverflow(admin);if(process.env.QA_SCREENSHOTS)await admin.screenshot({path:`${process.env.QA_SCREENSHOTS}/settings-360.png`,fullPage:true});
  await demo.close();console.log('PASS: v0.4 data preserved, completeness feedback, missing filter, schedule changes in open guest tab, staff status filter');
  // Server-bound room cannot be replaced through DOM manipulation.
  const bound=await browser.newContext();const boundPage=await bound.newPage();await boundPage.goto('http://127.0.0.1:8766/#access=bound-test');await boundPage.waitForSelector('.bubble');
  assert.equal(await boundPage.inputValue('#room'),'42');assert.ok(await boundPage.locator('#room').evaluate(e=>e.readOnly));
  await boundPage.locator('#room').evaluate(e=>{e.readOnly=false;e.value='99'});await send(boundPage,'Не работает отопление');
  assert.ok((await boundPage.locator('.bubble').last().innerText()).includes('Комната 42'));
  await bound.close();console.log('PASS: server-bound room remains authoritative after DOM tampering');

  assert.deepEqual(errors,[]);console.log('PASS: server login, guest ticket -> staff panel, workflow, settings -> guest answer, logout, no JS errors');
 }finally{if(browser)await browser.close();staticServer.kill();apiServer.kill();rmSync(temp,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
