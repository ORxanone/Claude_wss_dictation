// Veb backend testləri: saxta HOME, şəbəkə YOX. buildConnection + backend seçimi.
// İşlət: NODE_PATH=<node_modules> node test/web.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const SRC = path.join(__dirname, '..', 'src', 'voice-dictate.js');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vd2web-'));
  fs.mkdirSync(path.join(home, '.config')); fs.mkdirSync(path.join(home, '.cache'));
  return home;
}
function load(home) {
  const src = fs.readFileSync(SRC, 'utf8')
    .replace(/const \[, , cmd[\s\S]*$/, 'module.exports={buildConnection,readWebCred,cfg};')
    .replace('const HOME = os.homedir();', `const HOME = ${JSON.stringify(home)};`);
  const m = new module.constructor(SRC); m.paths = module.paths; m.filename = SRC;
  m._compile(src, SRC);
  return m.exports;
}
const cfgPath = (h) => path.join(h, '.config/voice-dictate2.json');
const webPath = (h) => path.join(h, '.config/voice-dictate2.web.json');
const setCfg = (h, o) => fs.writeFileSync(cfgPath(h), JSON.stringify(o));
const setWeb = (h, o) => fs.writeFileSync(webPath(h), JSON.stringify(o), { mode: 0o600 });

const tests = {
  'A: default backend = anthropic, cookie yoxdur'() {
    const h = sandbox(); const m = load(h);
    const conn = m.buildConnection('tr');
    assert.equal(conn.backend, 'anthropic');
    assert(conn.url.startsWith('wss://api.anthropic.com/'), conn.url);
    assert(!conn.headers || !conn.headers.Cookie);
    assert(!conn.url.includes('stt_provider'));
  },
  'B: web backend — düzgün url, parametrlər, cookie başlığı'() {
    const h = sandbox();
    setCfg(h, { backend: 'web' });
    setWeb(h, { sessionKey: 'sk-ant-sid02-TEST', organizationUuid: 'df00b20b-897f-4e1d-81a9-d4c0c5530074' });
    const conn = load(h).buildConnection('tr');
    assert.equal(conn.backend, 'web');
    assert(conn.url.startsWith('wss://claude.ai/'), conn.url);
    for (const p of ['stt_provider=deepgram-nova3', 'client_platform=web_claude_ai',
      'keepalive_ack=true', 'organization_uuid=df00b20b-897f-4e1d-81a9-d4c0c5530074', 'language=tr'])
      assert(conn.url.includes(p), 'çatışmır: ' + p);
    assert.equal(conn.headers.Origin, 'https://claude.ai');
    assert.equal(conn.headers.Cookie, 'sessionKey=sk-ant-sid02-TEST');
    assert(!conn.headers.Authorization, 'web-də Authorization olmamalı');
  },
  'C: web backend, web.json yoxdur — aydın xəta'() {
    const h = sandbox(); setCfg(h, { backend: 'web' });
    assert.throws(() => load(h).buildConnection('tr'), /web konfiqi yoxdur|web-login/);
  },
  'D: web.json natamam — sessionKey yoxdur'() {
    const h = sandbox(); setCfg(h, { backend: 'web' });
    setWeb(h, { organizationUuid: 'x' });
    assert.throws(() => load(h).buildConnection('tr'), /sessionKey yoxdur/);
  },
  'E: web.json faylı 0600 icazəli olmalı (web-login yazanda)'() {
    const h = sandbox();
    setWeb(h, { sessionKey: 'sk-ant-sid02-X', organizationUuid: 'y' });
    assert.equal(fs.statSync(webPath(h)).mode & 0o777, 0o600);
  },
  'F: anthropic backend cookie sızdırmır (web.json olsa belə)'() {
    const h = sandbox();
    setCfg(h, { backend: 'anthropic' });
    setWeb(h, { sessionKey: 'sk-ant-sid02-SECRET', organizationUuid: 'z' });
    const conn = load(h).buildConnection('tr');
    assert.equal(conn.backend, 'anthropic');
    assert(JSON.stringify(conn).indexOf('SECRET') === -1, 'anthropic url/headers-də cookie olmamalı');
  },
};
let fail = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('✅ ' + name); } catch (e) { fail++; console.log('❌ ' + name + '\n   ' + e.message); }
}
console.log(fail ? `\n${fail} test UĞURSUZ` : '\nBütün testlər keçdi');
process.exit(fail ? 1 : 0);
