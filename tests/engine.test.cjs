const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const E = require('../docs/engine.js');
const rules = require('../docs/rules.json');
const dict = require('../docs/i18n.json');
test('natural questions and faults in all four languages', () => {
 for (const [message, key] of [['Когда обед?', 'lunch'], ['Во сколько выезд?', 'checkout'], ['Когда нужно освободить номер?', 'checkout'], ['When is breakfast?', 'breakfast'], ['Wann ist das Mittagessen?', 'lunch'], ['Коли виїзд?', 'checkout'], ['Не работает интернет', 'internet'], ['WLAN funktioniert nicht', 'internet'], ['No hot water', 'water'], ['В комнате холодно', 'heating'], ['Нужны чистые полотенца', 'cleaning'], ['Потрібні рушники', 'cleaning'], ['Помогите, у меня проблема', 'help'], ['Где ближайший магазин?', 'shop'], ['Как вызвать такси?', 'taxi']]) assert.equal(E.classify(message, rules).key, key, message);
});
test('room clarification accepts natural answers and rejects unrelated text', () => {
 for (const s of ['12', 'комната 12', 'номер 12', '№ 12', 'Room 12', 'Zimmer 12', 'кімната 12']) assert.equal(E.roomNumber(s), '12');
 for (const s of ['Когда обед?', 'не знаю', '', 'сломался телевизор']) assert.equal(E.roomNumber(s), '');
});
test('localization key parity and language detection', () => {
 for (const l of ['de', 'en', 'uk']) assert.deepEqual(Object.keys(dict[l]), Object.keys(dict.ru));
 for (const [s, l] of [['В комнате холодно', 'ru'], ['У кімнаті холодно', 'uk'], ['The room is cold', 'en'], ['Das Zimmer ist kalt', 'de']]) assert.equal(E.language(s, 'ru'), l);
});
test('root mirror and versioned resources match', () => {
 assert.equal(fs.readFileSync('index.html', 'utf8'), fs.readFileSync('docs/index.html', 'utf8'));
 for (const p of ['docs/index.html', 'docs/staff.html']) for (const name of ['style.css', 'engine.js', 'ui.js']) assert.ok(fs.readFileSync(p, 'utf8').includes(name + '?v=' + rules.version));
});
test('v0.4.1 shared phrase corpus, ambiguities and late checkout', () => {
 for (const [message,group,key] of require('./phrases.json')) assert.deepEqual(E.classify(message,rules),{group,key},message);
});
test('single digit, keyboard normalization and short presentation IDs', () => {
 for(const s of ['8',' 8 ','№8','Room 8','８']) assert.equal(E.roomNumber(s),'8',s);
 for(const id of ['A82CDE1234567890','711936A1-525E-458C-9A5F-207F325F9C52','LEGACY-12']) {
  assert.ok(E.shortId(id).length<=8); assert.ok(E.shortId(id).length>0);
 }
 assert.equal(E.shortId('A82CDE1234567890'),'34567890');
});
