'use strict';
(async function () {
 const $ = id => document.getElementById(id);
 const E = HotelEngine;
 const isStaff = document.body.dataset.page === 'staff';
 const server = document.body.dataset.runtime === 'server';
 let lang = new URLSearchParams(location.search).get('lang') || 'ru';
 let dict, rules, settings = {}, tickets = [], users = [], me = null, pending = null, busy = false;
 const statuses = ['new', 'accepted', 'in_progress', 'done'];
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
 function bubble(text, mine = false) { $('chat').append(node('div', text, 'bubble' + (mine ? ' mine' : ''))); $('chat').scrollTop = $('chat').scrollHeight; }
 function infoValue(key) { return typeof settings[key] === 'object' && settings[key] ? settings[key][lang] || '' : ''; }
 function renderGuest() {
  $('hotelName').textContent = $('infoName').textContent = typeof settings.name === 'string' ? settings.name : 'GESHA HOTEL';
  $('address').textContent = typeof settings.address === 'string' ? settings.address : '';
  $('hotelLogo').hidden = true;
  if (typeof settings.logo === 'string' && settings.logo.startsWith('https://')) { $('hotelLogo').src = settings.logo; $('hotelLogo').hidden = false; }
  $('guestInfo').replaceChildren();
  for (const key of ['checkin', 'checkout', 'breakfast', 'lunch', 'dinner', 'wifi', 'parking', 'reception', 'services', 'information']) {
   const row = node('div', undefined, 'info-row'); row.append(node('strong', t(key)), node('p', infoValue(key) || t('missing'))); $('guestInfo').append(row);
  }
  $('chips').replaceChildren();
  for (const key of ['breakfast', 'lunch', 'checkout', 'wifi', 'parking']) { const b = node('button', t(key)); b.type = 'button'; b.onclick = () => submit(t(key)); $('chips').append(b); }
 }
 async function respond(message) {
  if (server) return api('/api/chat', {message, room: $('room').value, lang});
  const {group, key} = E.classify(message, rules);
  if (group === 'issues') {
   if (key === 'help') return {reply: t('needDetail'), need_detail: true};
   const room = E.roomNumber($('room').value);
   if (!room) return {reply: t('needRoom'), need_room: true};
   const id = crypto.randomUUID().slice(0, 18).toUpperCase();
   const ticket = {id, room, description: message, category: key, priority: 'normal', created_at: new Date().toISOString(), status: 'new', assignee: null};
   tickets.unshift(ticket);
   try { saveDemo(); } catch (e) { tickets.shift(); throw e; }
   return {reply: t('demoTicket').replace('{id}', id), ticket_id: id};
  }
  return {reply: group === 'faq' ? infoValue(key) || t('missing') : t('unknown')};
 }
 async function submit(input) {
  if (busy || !input.trim()) return;
  clearError(); busy = true; $('send').disabled = true;
  bubble(input, true);
  let message = input;
  try {
   const detected = E.language(input, lang);
   if (dict[detected] && detected !== lang) { lang = detected; renderText(); renderGuest(); }
   if (pending) {
    const room = E.roomNumber(input) || E.roomNumber($('room').value);
    if (room) { $('room').value = room; message = pending; }
    else if (!E.classify(input, rules).key) { bubble(t('needRoom')); return; }
    else { pending = null; }
   }
   const result = await respond(message);
   pending = result.need_room ? message : null;
   bubble(result.reply);
   $('message').value = '';
  } catch (e) { error(e); bubble(t('offline')); }
  finally { busy = false; $('send').disabled = false; $('cancel').hidden = !pending; }
 }
 function readSettings() {
  document.querySelectorAll('[data-field]').forEach(n => {
   const key = n.dataset.field;
   if (['name', 'logo', 'address'].includes(key)) settings[key] = n.value.trim();
   else { if (!settings[key] || typeof settings[key] !== 'object') settings[key] = {}; settings[key][lang] = n.value.trim(); }
  });
  settings.languages = [...document.querySelectorAll('[data-service-lang]:checked')].map(n => n.value);
 }
 function renderSettings() {
  const root = $('settings'); root.replaceChildren();
  for (const key of fields) {
   const label = node('label', t(key)); const input = node(['name', 'logo', 'address', 'checkin', 'checkout', 'breakfast', 'lunch', 'dinner'].includes(key) ? 'input' : 'textarea');
   input.dataset.field = key; input.maxLength = ['name', 'logo', 'address'].includes(key) ? 500 : 2000;
   input.value = ['name', 'logo', 'address'].includes(key) ? (typeof settings[key] === 'string' ? settings[key] : '') : infoValue(key);
   label.append(input); root.append(label);
  }
  const languageBox = node('div'); languageBox.append(node('p', t('languages')));
  for (const l of ['ru', 'de', 'en', 'uk']) { const label = node('label', dict[l].language + ' · ' + l.toUpperCase()); const input = node('input'); input.type = 'checkbox'; input.value = l; input.dataset.serviceLang = l; input.checked = (settings.languages || ['ru', 'de', 'en', 'uk']).includes(l); label.append(input); languageBox.append(label); }
  root.append(languageBox);
 }
 function select(options, selected) { const s = node('select'); for (const [value, label] of options) { const o = node('option', label); o.value = value; s.append(o); } s.value = selected || ''; return s; }
 function renderTickets() {
  $('stats').replaceChildren();
  for (const status of statuses) { const card = node('div', undefined, 'stat'); card.append(node('strong', String(tickets.filter(x => x.status === status).length)), node('span', t(status))); $('stats').append(card); }
  const root = $('tickets'); root.replaceChildren();
  const shown = tickets.filter(x => !$('filter').value || x.status === $('filter').value);
  if (!shown.length) root.append(node('p', t('empty')));
  for (const ticket of shown) {
   const row = node('article', undefined, 'ticket'); const heading = node('div', undefined, 'ticket-title'); heading.append(node('strong', t('room') + ' ' + ticket.room), node('span', t(ticket.status), 'badge')); row.append(heading, node('p', ticket.description));
   row.append(node('small', '#' + ticket.id + ' · ' + t(ticket.category) + ' · ' + (ticket.created_at ? new Date(ticket.created_at).toLocaleString(lang) : '—')));
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
  [dict, rules] = await Promise.all(['i18n.json', 'rules.json'].map(async path => { const r = await fetch(path + '?v=0.4.0', {cache: 'no-store'}); if (!r.ok) throw Error(); return r.json(); }));
  if (!dict[lang]) lang = 'ru';
  try { document.body.classList.toggle('dark', localStorage.getItem('gesha-theme') === 'dark'); } catch (_) {}
  renderText();
  if (!server) { try { loadDemo(); } catch (e) { error(e); } }
  $('theme').onclick = () => { const dark = document.body.classList.toggle('dark'); try { localStorage.setItem('gesha-theme', dark ? 'dark' : 'light'); } catch (_) {} };
  $('lang').onchange = async () => {
   if (isStaff && me && me.role !== 'staff') readSettings();
   lang = $('lang').value; renderText();
   if (isStaff && me) { renderSettings(); renderTickets(); const filter = $('filter'); for (const o of filter.options) o.textContent = t(o.value || 'all'); }
   else if (!isStaff) renderGuest();
  };
  if (!isStaff) {
   if (server) { const config = await api('/api/config'); settings = config.settings; $('room').value = config.room; $('room').readOnly = !!config.room; }
   renderGuest(); bubble(t('welcome'));
   $('chatForm').onsubmit = e => { e.preventDefault(); submit($('message').value); };
   $('cancel').onclick = () => { pending = null; $('cancel').hidden = true; bubble(t('cancelled')); };
  } else {
   $('loginForm').onsubmit = async e => { e.preventDefault(); clearError(); try { await api('/api/login', {hotel: $('loginHotel').value, name: $('loginName').value, password: $('loginPassword').value}); $('loginPassword').value = ''; await openWorkspace(); } catch (err) { error(err); } };
   $('logout').onclick = async () => { try { await api('/api/logout', {}); location.reload(); } catch (e) { error(e); } };
   $('filter').onchange = renderTickets;
   $('refresh').onclick = async () => { try { await refreshTickets(); } catch (e) { error(e); } };
   $('settingsForm').onsubmit = async e => { e.preventDefault(); clearError(); readSettings(); try { if (!settings.languages.length) throw Error(); if (server) await api('/api/settings', {settings}); else saveDemo('settings'); $('saved').textContent = ' ✓ ' + t('saved'); } catch (err) { error(err); } };
   $('linkForm').onsubmit = async e => { e.preventDefault(); try { const r = await api('/api/guest-links', {room: $('linkRoom').value}); $('guestURL').value = location.origin + r.url; } catch (err) { error(err); } };
   $('userForm').onsubmit = async e => { e.preventDefault(); try { await api('/api/users', {name: $('newName').value, password: $('newPassword').value, role: $('newRole').value}); $('newPassword').value = ''; await openWorkspace(); } catch (err) { error(err); } };
   try { await openWorkspace(); } catch (e) { if (e.status !== 401) error(e); }
  }
 } catch (e) { if (dict) error(e); else { $('error').hidden = false; $('error').textContent = 'Unable to load interface / Не удалось загрузить интерфейс. Reload / Обновите страницу.'; } }
})();
