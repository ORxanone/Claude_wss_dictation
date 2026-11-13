// Token modulunun təcrid olunmuş testi: saxta HOME, saxta fetch. Real tokenə/şəbəkəyə toxunmur.
// İşlət: NODE_PATH=<node_modules> node test/token.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const SRC = path.join(__dirname, '..', 'src', 'voice-dictate.js');

function sandbox(bundleOk = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vd2test-'));
  fs.mkdirSync(path.join(home, '.claude')); fs.mkdirSync(path.join(home, '.cache'));
  const vdir = path.join(home, '.local/share/claude/versions'); fs.mkdirSync(vdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, '9.9.9'), bundleOk
    ? 'xx .oauth_refresh.lock stale:60000,update:5000 claudeAiOauth grant_type:"refresh_token" xx' : 'nothing');
  return home;
}
function load(home) {
  process.env.HOME = home;
  delete require.cache[require.resolve('os')];
  const src = fs.readFileSync(SRC, 'utf8').replace(/const \[, , cmd[\s\S]*$/,
    'module.exports={ensureAccessToken};');
  const m = new module.constructor(SRC); m.paths = module.paths; m.filename = SRC;
  m._compile(src.replace("const HOME = os.homedir();", `const HOME = ${JSON.stringify(home)};`), SRC);
  return m.exports;
}
const credPath = (h) => path.join(h, '.claude/.credentials.json');
function writeCred(h, o) {
  fs.writeFileSync(credPath(h), JSON.stringify({ mcpOAuth: { keep: 1 }, claudeAiOauth: {
    scopes: ['user:inference'], subscriptionType: 'max', ...o } }), { mode: 0o600 });
}
const readCred = (h) => JSON.parse(fs.readFileSync(credPath(h), 'utf8'));
const locks = (h) => [path.join(h, '.claude/.oauth_refresh.lock'), path.join(h, '.claude.lock')];
let fetchCalls = 0;
function stubFetch(fn) { fetchCalls = 0; global.fetch = async (...a) => { fetchCalls++; return fn(...a); }; }
const okResp = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const PAST = () => Date.now() - 1000, FUT = () => Date.now() + 3600e3;

const tests = {
  async 'A: etibarlı token — oxuyur, yeniləmir, kilid yox'() {
    const h = sandbox(); writeCred(h, { accessToken: 'A1', refreshToken: 'R1', expiresAt: FUT() });
    stubFetch(() => { throw new Error('çağırılmamalı'); });
    assert.equal(await load(h).ensureAccessToken(), 'A1'); assert.equal(fetchCalls, 0);
    assert(!locks(h).some(fs.existsSync));
  },
  async 'B: Claude Code kilidi tutub yeniləyir — gözləyir, onun tokenini götürür, fetch YOX'() {
    const h = sandbox(); writeCred(h, { accessToken: 'OLD', refreshToken: 'R1', expiresAt: PAST() });
    fs.mkdirSync(locks(h)[0]);
    setTimeout(() => { writeCred(h, { accessToken: 'CC_NEW', refreshToken: 'R2', expiresAt: FUT() }); fs.rmdirSync(locks(h)[0]); }, 2500);
    stubFetch(() => { throw new Error('çağırılmamalı'); });
    assert.equal(await load(h).ensureAccessToken(), 'CC_NEW'); assert.equal(fetchCalls, 0);
    assert(!locks(h).some(fs.existsSync));
  },
  async 'C: kilid boş — kilid altında yeniləyir, CAS yazır, digər açarlar qalır, mode 600'() {
    const h = sandbox(); writeCred(h, { accessToken: 'OLD', refreshToken: 'R1', expiresAt: PAST() });
    let sawLocks = false;
    stubFetch(async (url, opt) => {
      sawLocks = locks(h).every(fs.existsSync);
      const b = JSON.parse(opt.body); assert.equal(b.refresh_token, 'R1'); assert.equal(b.scope, 'user:inference');
      return okResp({ access_token: 'NEW', refresh_token: 'R2', expires_in: 28800, scope: 'user:inference user:profile' });
    });
    assert.equal(await load(h).ensureAccessToken(), 'NEW');
    assert(sawLocks, 'fetch zamanı hər iki Claude Code kilidi tutulmalı idi');
    const c = readCred(h);
    assert.equal(c.claudeAiOauth.refreshToken, 'R2'); assert.equal(c.mcpOAuth.keep, 1);
    assert.equal(c.claudeAiOauth.subscriptionType, 'max');
    assert.equal(fs.statSync(credPath(h)).mode & 0o777, 0o600);
    assert(!locks(h).some(fs.existsSync), 'kilidlər buraxılmalı idi');
    assert(!fs.readdirSync(path.join(h, '.claude')).some((f) => f.endsWith('.tmp')));
  },
  async 'D: invalid_grant — xəta, fayl TOXUNULMAZ (heç nə silinmir)'() {
    const h = sandbox(); writeCred(h, { accessToken: 'OLD', refreshToken: 'R1', expiresAt: PAST() });
    const before = fs.readFileSync(credPath(h), 'utf8');
    stubFetch(async () => ({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' }));
    await assert.rejects(load(h).ensureAccessToken(), /yenilənmədi/);
    assert.equal(fs.readFileSync(credPath(h), 'utf8'), before);
    assert(!locks(h).some(fs.existsSync));
  },
  async 'E: CAS — fetch zamanı fayl dəyişsə, üstünə YAZMIR'() {
    const h = sandbox(); writeCred(h, { accessToken: 'OLD', refreshToken: 'R1', expiresAt: PAST() });
    stubFetch(async () => { writeCred(h, { accessToken: 'OTHER', refreshToken: 'R9', expiresAt: FUT() });
      return okResp({ access_token: 'NEW', refresh_token: 'R2', expires_in: 100 }); });
    assert.equal(await load(h).ensureAccessToken(), 'OTHER');
    assert.equal(readCred(h).claudeAiOauth.refreshToken, 'R9');
  },
  async 'F: ölü (2 dəq köhnə) kilid — götürülür'() {
    const h = sandbox(); writeCred(h, { accessToken: 'OLD', refreshToken: 'R1', expiresAt: PAST() });
    fs.mkdirSync(locks(h)[0]); const old = new Date(Date.now() - 120e3); fs.utimesSync(locks(h)[0], old, old);
    stubFetch(async () => okResp({ access_token: 'NEW', refresh_token: 'R2', expires_in: 100 }));
    assert.equal(await load(h).ensureAccessToken(), 'NEW');
  },
  async 'G: Claude Code kilid protokolu tanınmır — YENİLƏMİR'() {
    const h = sandbox(false); writeCred(h, { accessToken: 'OLD', refreshToken: 'R1', expiresAt: PAST() });
    stubFetch(() => { throw new Error('çağırılmamalı'); });
    await assert.rejects(load(h).ensureAccessToken(), /protokolu tanınmadı/); assert.equal(fetchCalls, 0);
  },
  async 'H: 401, amma faylda artıq təzə token — fetch YOX'() {
    const h = sandbox(); writeCred(h, { accessToken: 'FRESH', refreshToken: 'R2', expiresAt: FUT() });
    stubFetch(() => { throw new Error('çağırılmamalı'); });
    assert.equal(await load(h).ensureAccessToken(true, 'STALE'), 'FRESH'); assert.equal(fetchCalls, 0);
  },
};
(async () => {
  let fail = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try { await fn(); console.log('✅ ' + name); } catch (e) { fail++; console.log('❌ ' + name + '\n   ' + e.message); }
  }
  console.log(fail ? `\n${fail} test UĞURSUZ` : '\nBütün testlər keçdi'); process.exit(fail ? 1 : 0);
})();
