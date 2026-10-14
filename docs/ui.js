'use strict';
(async function () {
 const $ = id => document.getElementById(id);
 const E = HotelEngine;
 const isStaff = document.body.dataset.page === 'staff';
 const server = document.body.dataset.runtime === 'server';
 let lang = new URLSearchParams(location.search).get('lang') || 'ru';
 let dict, rules, settings = {}, tickets = [], users = [], me = null, pending = null, busy = false, boundRoom = '', missingOnly = false, settingsDirty = false;
 const statuses = ['new', 'accepted', 'in_progress', 'done'];
 const essentialFields = ['breakfast', 'lunch', 'dinner', 'checkin', 'checkout', 'wifi', 'parking', 'reception', 'services'];
 const fields = ['name', 'logo', 'address', 'reception', 'checkin', 'checkout', 'breakfast', 'lunch', 'dinner', 'wifi', 'parking', 'services', 'shop', 'taxi', 'information'];
 const storeKey = 'gesha-hotel-demo-v04';
 const guestToken = new URLSearchParams(location.hash.slice(1)).get('access') || '';
 // Guest credential stays in the fragment and memory; never in requests' URLs or localStorage.
 const t = key => dict[lang][key] || key;
 function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
 function error(e) { $('error').hidden = false; $('error').textContent = t('error') + (e?.status ? ` (${e.status})` : ''); }
 function clearError() { $('error').hidden = true; }
 async function api(path, body) {
  const response = await fetch(path, {method: body === undefined ? 'GET' : 'POST', cache: 'no-store', headers: {'Content-Type': 'application/json', 'X-Requested-With': 'gesha', 'X-Guest-Token': guestToken}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  if (!response.ok) { const e = new Error('HTTP'); e.status = response.status; throw e; }
  return response.json();
 }
 function saveDemo(part = 'tickets') { const current = JSON.parse(localStorage.getItem(storeKey) || '{}'); localStorage.setItem(storeKey, JSON.stringify({settings: part === 'settings' ? settings : current.settings || settings, tickets: part === 'tickets' ? tickets : current.tickets || tickets})); }
 function loadDemo() {
  const saved = localStorage.getItem(storeKey);
  if (saved) { const d = JSON.parse(saved); settings = d.settings || {}; tickets = Array.isArray(d.tickets) ? d.tickets : []; return; }
  settings = {name: 'GESHA HOTEL', languages: ['ru', 'de', 'en', 'uk']};
  // Preserve old storage keys; import v0.3 data without deleting the source.
  const old = JSON.parse(localStorage.getItem('gesha-hotel-info-v03') || '{}');
  if (old && typeof old === 'object') for (const key of fields) if (typeof old[key] === 'string') settings[key] = {ru: old[key]};
  const rows = JSON.parse(localStorage.getItem('gesha-hotel-demo-v02') || '[]');
  if (Array.isArray(rows)) tickets = rows.filter(x => x && typeof x.message === 'string').map(x => ({id: 'LEGACY-' + x.id, room: x.room || '', description: x.message, category: 'repair', priority: 'normal', created_at: null, status: x.status === 'готово' ? 'done' : 'new', assignee: null}));
 }
 function renderText() {
  document.documentElement.lang = lang; $('lang').value = lang;
  document.querySelectorAll('[data-t]').forEach(n => n.textContent = t(n.dataset.t));
  document.querySelectorAll('[data-placeholder]').forEach(n => n.placeholder = t(n.dataset.placeholder));
  $('mode').textContent = t(server ? 'server' : 'demo');
  $('other').textContent = t(isStaff ? 'guest' : 'staff');
  $('other').href = (isStaff ? './' : server ? '/staff' : 'staff.html') + '?lang=' + lang;
 }
 function scrollChat() { requestAnimationFrame(() => { $('chat').scrollTop = $('chat').scrollHeight; }); }
 function bubble(text, mine = false, ticketId = '') { const b = node('div', text, 'bubble' + (mine ? ' mine' : '')); if (ticketId) { b.dataset.ticketId = ticketId; b.title = t('fullId') + ': ' + ticketId; } $('chat').append(b); scrollChat(); }
 function renderRoom() { const room = boundRoom || E.roomNumber($('room').value); $('roomStatus').textContent = room ? t('roomSaved').replace('{room}', room) : t('roomEmpty'); $('roomStatus').classList.toggle('valid', !!room); }
 function formatTicket(template, ticket) { return template.replace('{id}', E.shortId(ticket.id)).replace('{room}', ticket.room).replace('{category}', t(ticket.category)); }
 function infoValue(key) { return typeof settings[key] === 'object' && settings[key] ? settings[key][lang] || '' : ''; }
 function renderGuest() {
  renderRoom();
  $('hotelName').textContent = $('infoName').textContent = typeof settings.name === 'string' ? settings.name : 'GESHA HOTEL';
  $('address').textContent = typeof settings.address === 'string' ? settings.address : '';
  $('hotelLogo').hidden = true;
  if (typeof settings.logo === 'string' && settings.logo.startsWith('https://')) { $('hotelLogo').src = settings.logo; $('hotelLogo').hidden = false; }
  $('guestInfo').replaceChildren();
  for (const key of ['checkin', 'checkout', 'breakfast', 'lunch', 'dinner', 'wifi', 'parking', 'reception', 'services', 'information']) {
   const value = infoValue(key); if (!value) continue;
   const row = node('div', undefined, 'info-row'); row.append(node('strong', t(key)), node('p', value)); $('guestInfo').append(row);
  }
  if (!$('guestInfo').children.length) $('guestInfo').append(node('p', t('missing')));
  $('chips').replaceChildren();
  for (const key of ['breakfast', 'lunch', 'checkout', 'wifi', 'parking']) { const b = node('button', t(key)); b.type = 'button'; b.onclick = () => submit(t(key)); $('chips').append(b); }
 }
 async function respond(message, room) {
  if (server) return api('/api/chat', {message, room, lang});
  // Refresh facts and requests from another open demo tab before answering.
  loadDemo(); renderGuest();
  const {group, key} = E.classify(message, rules);
  if (group === 'guards') return {reply: t(key), need_detail: true};
  if (group === 'issues') {
   if (key === 'help') return {reply: t('needDetail'), need_detail: true};
   if (!room) return {reply: t('needRoom'), need_room: true};
   const id = crypto.randomUUID().toUpperCase();
   const ticket = {id, room, description: message, category: key, priority: 'normal', created_at: new Date().toISOString(), status: 'new', assignee: null};
   tickets.unshift(ticket);
   try { saveDemo(); } catch (e) { tickets.shift(); throw e; }
   return {reply: formatTicket(t('demoTicket'), ticket), ticket_id: id, room, category: key};
  }
  return {reply: group === 'faq' ? infoValue(key) || t('missing') : t('unknown')};
 }
 async function submit(input) {
  if (busy || !input.trim()) return;
  clearError(); busy = true; $('send').disabled = true;
  bubble(input, true);
  // Capture the entered room before any language rendering or async operation.
  let room = boundRoom || E.roomNumber($('room').value);
  let message = input;
  try {
   const detected = E.language(input, lang);
   if (dict[detected] && detected !== lang) { lang = detected; renderText(); renderGuest(); }
   if (pending) {
    const roomAnswer = E.roomNumber(input);
    const intent = E.classify(input, rules);
    if (roomAnswer) { room = boundRoom || roomAnswer; message = pending; }
    else if (intent.key) { pending = null; }
    else if (room) { message = pending; }
    else { bubble(t('needRoom')); return; }
   }
   if (room) $('room').value = room;
   renderRoom();
   const result = await respond(message, room);
   pending = result.need_room ? message : null;
   if (result.room) { $('room').value = result.room; renderRoom(); }
   bubble(result.reply, false, result.ticket_id);
   $('message').value = '';
  } catch (e) { error(e); bubble(t('offline')); }
  finally { busy = false; $('send').disabled = false; $('cancel').hidden = !pending; scrollChat(); }
 }
 function readSettings() {
  document.querySelectorAll('[data-field]').forEach(n => {
   const key = n.dataset.field;
   if (['name', 'logo', 'address'].includes(key)) settings[key] = n.value.trim();
   else { if (!settings[key] || typeof settings[key] !== 'object') settings[key] = {}; settings[key][lang] = n.value.trim(); }
  });
  settings.languages = [...document.querySelectorAll('[data-service-lang]:checked')].map(n => n.value);
 }
 function settingsState() {
  let done = 0;
  document.querySelectorAll('.setting-field').forEach(label => {
   const input = label.querySelector('[data-field]'); const filled = !!input.value.trim();
   label.querySelector('.field-state').textContent = t(filled ? 'filled' : 'missingField');
   label.classList.toggle('is-filled', filled); label.hidden = missingOnly && filled && document.activeElement !== input;
   if (essentialFields.includes(input.dataset.field) && filled) done++;
  });
  $('settingsProgress').textContent = t('settingsProgress').replace('{done}', done).replace('{total}', essentialFields.length);
  $('missingToggle').textContent = t(missingOnly ? 'allFields' : 'showMissing');
  $('missingToggle').setAttribute('aria-pressed', String(missingOnly));
 }
 function renderSettings() {
  const root = $('settings'); root.replaceChildren();
  const groups = [['mealsGroup', ['breakfast', 'lunch', 'dinner']], ['stayGroup', ['checkin', 'checkout', 'wifi', 'parking', 'reception', 'services']], ['hotelGroup', fields.filter(x => !essentialFields.includes(x))]];
  for (const [title, keys] of groups) {
   const group = node('fieldset', undefined, 'settings-group'); group.append(node('legend', t(title)));
   const grid = node('div', undefined, 'settings-grid');
   for (const key of keys) {
    const label = node('label', undefined, 'setting-field');
    const heading = node('span', undefined, 'field-heading'); heading.append(node('span', t(key)), node('small', '', 'field-state')); label.append(heading);
    const input = node(['name', 'logo', 'address', 'checkin', 'checkout', 'breakfast', 'lunch', 'dinner'].includes(key) ? 'input' : 'textarea');
    input.dataset.field = key; input.maxLength = ['name', 'logo', 'address'].includes(key) ? 500 : 2000;
    input.value = ['name', 'logo', 'address'].includes(key) ? (typeof settings[key] === 'string' ? settings[key] : '') : infoValue(key);
    input.placeholder = t('missingField'); label.append(input); grid.append(label);
   }
   group.append(grid); root.append(group);
  }
  const languageBox = node('fieldset', undefined, 'service-languages'); languageBox.append(node('legend', t('languages')));
  for (const l of ['ru', 'de', 'en', 'uk']) { const label = node('label', dict[l].language + ' · ' + l.toUpperCase()); const input = node('input'); input.type = 'checkbox'; input.value = l; input.dataset.serviceLang = l; input.checked = (settings.languages || ['ru', 'de', 'en', 'uk']).includes(l); label.prepend(input); languageBox.append(label); }
  root.append(languageBox); settingsState();
  $('saved').textContent = settingsDirty ? t('unsaved') : '';
 }
 function select(options, selected) { const s = node('select'); for (const [value, label] of options) { const o = node('option', label); o.value = value; s.append(o); } s.value = selected || ''; return s; }
 function renderTickets() {
  $('stats').replaceChildren();
  for (const status of statuses) { const card = node('div', undefined, 'stat'); card.append(node('strong', String(tickets.filter(x => x.status === status).length)), node('span', t(status))); $('stats').append(card); }
  const root = $('tickets'); root.replaceChildren();
  const shown = tickets.filter(x => !$('filter').value || x.status === $('filter').value);
  if (!shown.length) root.append(node('p', t('empty')));
  for (const ticket of shown) {
   const row = node('article', undefined, 'ticket'); row.dataset.ticketId = ticket.id; const heading = node('div', undefined, 'ticket-title'); heading.append(node('strong', t('room') + ' ' + ticket.room), node('span', t(ticket.status), 'badge status-' + ticket.status)); row.append(heading, node('p', ticket.description));
   row.append(node('small', '#' + E.shortId(ticket.id) + ' · ' + t(ticket.category) + ' · ' + (ticket.created_at ? new Date(ticket.created_at).toLocaleString(lang) : '—')));
   const fullId = node('details', undefined, 'ticket-id'); fullId.append(node('summary', t('fullId')), node('code', ticket.id)); row.append(fullId);
   const controls = node('div', undefined, 'ticket-controls');
   const assigned = select([['', t('unassigned')], ...users.map(x => [x.id, x.name])], ticket.assignee);
   const priority = select(['low', 'normal', 'high'].map(x => [x, t(x)]), ticket.priority);
   for (const [key, el] of [['assignee', assigned], ['priority', priority]]) { const label = node('label', t(key)); label.append(el); controls.append(label); el.disabled = me.role === 'staff'; }
   async function update(status) {
    clearError();
    try {
     if (server) await api('/api/tickets/status', {id: ticket.id, status, assignee: assigned.value, priority: priority.value});
     else { const old = {...ticket}; Object.assign(ticket, {status, assignee: assigned.value || null, priority: priority.value}); try { saveDemo(); } catch (e) { Object.assign(ticket, old); throw e; } }
     await refreshTickets();
    } catch (e) { error(e); }
   }
   if (me.role !== 'staff') { const save = node('button', t('save')); save.onclick = () => update(ticket.status); controls.append(save); }
   const next = statuses[statuses.indexOf(ticket.status) + 1];
   if (next) { const b = node('button', t('next') + ': ' + t(next)); b.onclick = () => update(next); controls.append(b); }
   row.append(controls); root.append(row);
  }
 }
 async function refreshTickets() { if (server) tickets = await api('/api/tickets'); else { const saved = JSON.parse(localStorage.getItem(storeKey) || '{}'); if (Array.isArray(saved.tickets)) tickets = saved.tickets; } renderTickets(); }
 async function openWorkspace() {
  if (server) { me = await api('/api/me'); users = await api('/api/users'); if (me.role !== 'staff') settings = await api('/api/settings'); }
  else { me = {name: 'Demo', role: 'owner'}; users = [{id: 'demo-staff', name: 'Demo'}]; }
  $('identity').textContent = me.name + ' · ' + t(me.role === 'staff' ? 'staffRole' : me.role);
  $('loginForm').hidden = true; $('workspace').hidden = false; $('logout').hidden = !server;
  $('managerArea').hidden = me.role === 'staff'; $('ownerArea').hidden = me.role !== 'owner' || !server; $('linkForm').hidden = !server;
  const previous = $('filter').value; $('filter').replaceChildren(); for (const key of ['', ...statuses]) { const o = node('option', t(key || 'all')); o.value = key; $('filter').append(o); } $('filter').value = previous;
  renderSettings(); await refreshTickets();
 }
 try {
  [dict, rules] = await Promise.all(['i18n.json', 'rules.json'].map(async path => { const r = await fetch(path + '?v=0.4.1', {cache: 'no-store'}); if (!r.ok) throw Error(); return r.json(); }));
  if (!dict[lang]) lang = 'ru';
  try { document.body.classList.toggle('dark', localStorage.getItem('gesha-theme') === 'dark'); } catch (_) {}
  renderText();
  if (!server) { try { loadDemo(); } catch (e) { error(e); } }
  $('theme').onclick = () => { const dark = document.body.classList.toggle('dark'); try { localStorage.setItem('gesha-theme', dark ? 'dark' : 'light'); } catch (_) {} };
  $('lang').onchange = async () => {
   if (isStaff && me && me.role !== 'staff') readSettings();
   lang = $('lang').value; renderText();
   if (isStaff && me) { $('identity').textContent = me.name + ' · ' + t(me.role === 'staff' ? 'staffRole' : me.role); renderSettings(); renderTickets(); const filter = $('filter'); for (const o of filter.options) o.textContent = t(o.value || 'all'); }
   else if (!isStaff) renderGuest();
  };
  if (!isStaff) {
   if (server) { const config = await api('/api/config'); settings = config.settings; boundRoom = config.room || ''; if (boundRoom) $('room').value = boundRoom; $('room').readOnly = !!boundRoom; }
   renderGuest(); bubble(t('welcome'));
   $('room').addEventListener('input', renderRoom); $('room').addEventListener('change', renderRoom);
   window.visualViewport?.addEventListener('resize', scrollChat);
   $('message').addEventListener('focus', scrollChat);
   $('chatForm').onsubmit = e => { e.preventDefault(); submit($('message').value); };
   $('cancel').onclick = () => { pending = null; $('cancel').hidden = true; bubble(t('cancelled')); };
  } else {
   $('loginForm').onsubmit = async e => { e.preventDefault(); clearError(); try { await api('/api/login', {hotel: $('loginHotel').value, name: $('loginName').value, password: $('loginPassword').value}); $('loginPassword').value = ''; await openWorkspace(); } catch (err) { error(err); } };
   $('logout').onclick = async () => { try { await api('/api/logout', {}); location.reload(); } catch (e) { error(e); } };
   $('filter').onchange = renderTickets;
   $('refresh').onclick = async () => { try { await refreshTickets(); } catch (e) { error(e); } };
   $('missingToggle').onclick = () => { missingOnly = !missingOnly; settingsState(); };
   $('settingsForm').oninput = () => { settingsDirty = true; $('saved').textContent = t('unsaved'); settingsState(); };
   $('settingsForm').onsubmit = async e => { e.preventDefault(); clearError(); readSettings(); try { if (!settings.languages.length) throw Error(); if (server) await api('/api/settings', {settings}); else saveDemo('settings'); settingsDirty = false; $('saved').textContent = ' ✓ ' + t('saved'); settingsState(); } catch (err) { error(err); } };
   $('linkForm').onsubmit = async e => { e.preventDefault(); try { const r = await api('/api/guest-links', {room: $('linkRoom').value}); $('guestURL').value = location.origin + r.url; } catch (err) { error(err); } };
   $('userForm').onsubmit = async e => { e.preventDefault(); try { await api('/api/users', {name: $('newName').value, password: $('newPassword').value, role: $('newRole').value}); $('newPassword').value = ''; await openWorkspace(); } catch (err) { error(err); } };
   try { await openWorkspace(); } catch (e) { if (e.status !== 401) error(e); }
  }
 } catch (e) { if (dict) error(e); else { $('error').hidden = false; $('error').textContent = 'Unable to load interface / Не удалось загрузить интерфейс. Reload / Обновите страницу.'; } }
})();
