#!/usr/bin/env node
/*
 * voice-dictate2 — Anthropic-in diktə sistemindən (Claude Code-la eyni endpoint)
 * istənilən yerdə istifadə: qısayol → danış → mətn kursora + clipboard-a.
 *
 * v2 (ayrıca layihə, v1 ilə yan-yana işləyir — adlar fərqlidir):
 *   - System tray ikonu (StatusNotifierItem): sol klik = başlat/dayandır, orta klik = ləğv
 *   - Səssizlik avto-dayandırma (silenceStopMs) + maksimum müddət (maxRecordMs)
 *   - check-endpoint: Claude Code yenilənəndə protokolun dəyişib-dəyişmədiyini yoxlayır
 *   - User-Agent versiyası quraşdırılmış Claude Code-dan avtomatik götürülür
 *   - ydotool socket-i env-dən asılı olmadan tapılır
 *
 * Protokol (Claude Code 2.1.322 bundle-ından çıxarıldı):
 *   wss://api.anthropic.com/api/ws/speech_to_text/voice_stream
 *     ?encoding=linear16&sample_rate=16000&channels=1
 *     &endpointing_ms=300&utterance_end_ms=1000&language=<xx>
 *     &use_conversation_engine=true
 *   Headers: Authorization: Bearer <claude.ai OAuth token>, x-app: cli
 *   Göndərilən: {"type":"KeepAlive"} (open + hər 5s),
 *               binary PCM s16le/16k/mono chunk-lar, {"type":"CloseStream"}
 *   Gələn: {"type":"TranscriptInterim"|"TranscriptText","data":...},
 *          {"type":"TranscriptEndpoint"}, {"type":"TranscriptError",...}
 *
 * Komandalar: start | stop | toggle | cancel | status | test <san> | check-endpoint | listen
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

// ---------- adlar (v1 ilə toqquşmasın) ----------
const APP = 'voice-dictate2';
const DBUS_NAME = 'org.local.VoiceDictate2';
const DBUS_PATH = '/org/local/VoiceDictate2';

const HOME = os.homedir();
const CFG_PATH = path.join(HOME, '.config', APP + '.json');
const CFG_FALLBACK = path.join(HOME, '.config', 'voice-dictate.json'); // v1 konfiqi
const CRED_PATH = path.join(HOME, '.claude', '.credentials.json');
const STATE_PATH = path.join(HOME, '.cache', APP + '.state.json');
const PASTE_LOG = path.join(HOME, '.cache', APP + '-paste.log');
const CLAUDE_VERSIONS = path.join(HOME, '.local', 'share', 'claude', 'versions');

const WS_BASE = 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_SCOPE = 'user:profile user:inference user:sessions:claude_code ' +
  'user:mcp_servers user:file_upload user:plugins';
const KNOWN_GOOD_VERSION = '2.1.322';
const KEEPALIVE_MS = 5000;
const FINALIZE_TIMEOUT_MS = 6000;
const MIN_BYTES = 8000; // ~0.25 saniyə səs

const DEFAULTS = {
  language: 'tr',          // az server tərəfindən dəstəklənmir; tr azərbaycanca yaxşı yazır
  silenceStopMs: 15000,    // bu qədər səssizlikdən sonra avtomatik dayandır (0 = söndür)
  maxRecordMs: 120000,     // maksimum yazma müddəti
  silenceRms: 400,         // bu RMS-dən aşağı = səssizlik (s16, 0..32767)
  tray: true,              // system tray ikonu
  restoreClipboard: true,  // paste-dən sonra əvvəlki clipboard-u qaytar (transcript Super+V-də qalır)
  clientVersion: '',       // boş = Claude Code versiyası avtomatik
};

function cfg() {
  let user = {};
  for (const p of [CFG_PATH, CFG_FALLBACK]) {
    try { user = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch {}
  }
  return { ...DEFAULTS, ...user };
}
function log(...a) { console.log('[' + APP + ']', ...a); }

function notify(summary, body, urgent) {
  try {
    spawn('notify-send', ['-a', APP,
      ...(urgent ? ['-u', 'critical'] : ['-u', 'normal']),
      summary, body || ''], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

// ---------- Claude Code versiyası ----------
function cmpVer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
function latestClaudeVersion() {
  try {
    const vs = fs.readdirSync(CLAUDE_VERSIONS).filter((v) => /^\d+(\.\d+)*$/.test(v));
    vs.sort(cmpVer);
    return vs[vs.length - 1] || null;
  } catch { return null; }
}
function userAgent() {
  const v = cfg().clientVersion || latestClaudeVersion() || KNOWN_GOOD_VERSION;
  return `claude-cli/${v} (external, cli)`;
}

// ---------- token ----------
function readOauth() {
  const c = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  const o = c.claudeAiOauth || c;
  if (!o.accessToken) throw new Error('claude.ai token tapılmadı');
  return { file: c, oauth: o };
}

function expOf(oauth) {
  return typeof oauth.expiresAt === 'number' ? oauth.expiresAt
    : (Date.parse(oauth.expiresAt) || 0);
}

// Refresh token rotasiya olunur: eyni köhnə refresh_token-i iki proses işlədərsə,
// biri invalid_grant alır → Claude Code yenidən /login istəyə bilər.
// Ona görə: (1) bizim proseslər arasında lock, (2) yeniləmədən dərhal əvvəl faylı
// yenidən oxu — başqası (Claude Code) artıq yeniləyibsə, onun tokenini işlət.
const REFRESH_LOCK = path.join(HOME, '.cache', APP + '.refresh.lock');
async function withRefreshLock(fn) {
  for (let i = 0; i < 50; i++) {
    try {
      const fd = fs.openSync(REFRESH_LOCK, 'wx');
      fs.closeSync(fd);
      try { return await fn(); } finally { try { fs.unlinkSync(REFRESH_LOCK); } catch {} }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { // 30s-dən köhnə lock ölü prosesdən qalıb
        if (Date.now() - fs.statSync(REFRESH_LOCK).mtimeMs > 30000) fs.unlinkSync(REFRESH_LOCK);
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return fn(); // 10s gözlədik — lock-suz davam
}

// failedToken: server 401 verdiyi token (force rejimində)
async function ensureAccessToken(force, failedToken) {
  const first = readOauth().oauth;
  if (!force && expOf(first) > Date.now() + 60000) return first.accessToken;

  return withRefreshLock(async () => {
    // lock-u gözləyərkən başqası yeniləmiş ola bilər
    const { file, oauth } = readOauth();
    const someoneRefreshed = force
      ? (failedToken && oauth.accessToken !== failedToken)
      : expOf(oauth) > Date.now() + 60000;
    if (someoneRefreshed) { log('token artıq başqası tərəfindən yenilənib'); return oauth.accessToken; }
    if (!oauth.refreshToken) return oauth.accessToken;
    log('token müddəti bitib, yenilənir...');
    return doRefresh(file, oauth);
  });
}

async function doRefresh(file, oauth) {
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent() },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: OAUTH_SCOPE,
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    oauth.accessToken = j.access_token;
    if (j.refresh_token) oauth.refreshToken = j.refresh_token;
    oauth.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
    if (j.refresh_token_expires_in) oauth.refreshTokenExpiresAt = Date.now() + j.refresh_token_expires_in * 1000;
    // yazmadan dərhal əvvəl ən təzə faylı oxu (mcpOAuth və s. digər açarlar itməsin)
    let fresh = file;
    try { fresh = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8')); } catch {}
    if (fresh.claudeAiOauth) fresh.claudeAiOauth = { ...fresh.claudeAiOauth, ...oauth };
    else Object.assign(fresh, oauth);
    const tmp = CRED_PATH + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(fresh, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CRED_PATH);
    log('token yeniləndi');
    return oauth.accessToken;
  } catch (e) {
    // uğursuz oldu (məs. invalid_grant — başqası rotasiya edib): fayldakı ən təzə tokeni işlət
    log('token yenilənmədi (' + e.message + '), fayldakı token işlədilir');
    try { return readOauth().oauth.accessToken; } catch { return oauth.accessToken; }
  }
}

// ---------- audio yazıcı ----------
function startRecorder() {
  let child = spawn('pw-record', ['--rate', '16000', '--channels', '1',
    '--format', 's16', '--raw', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let failed = false;
  child.once('error', () => {
    if (failed) return;
    failed = true;
    child = spawn('ffmpeg', ['-f', 'pulse', '-i', 'default',
      '-ar', '16000', '-ac', '1', '-f', 's16le', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    child.once('error', () => {});
  });
  return child;
}

// s16le chunk-ın RMS-i
function rms(buf) {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2); sum += s * s; }
  return Math.sqrt(sum / n);
}

// ---------- əsas: yaz + transkripsiya ----------
async function recordAndTranscribe(opts, onChunk, allowRetry = true) {
  const c = cfg();
  const language = process.env.VD_LANG || c.language;
  const token = await ensureAccessToken();

  const params = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    endpointing_ms: '300',
    utterance_end_ms: '1000',
    language,
    use_conversation_engine: 'true',
  });

  const ws = new WebSocket(`${WS_BASE}?${params}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': userAgent(),
      'x-app': 'cli',
      'anthropic-client-platform': 'Linux',
    },
    handshakeTimeout: 10000,
  });

  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('unexpected-response', (req, res) => {
        const e = new Error(`WS rədd edildi: HTTP ${res.statusCode}` +
          (res.headers['cf-mitigated'] ? ' (Cloudflare)' : ''));
        e.statusCode = res.statusCode;
        reject(e);
      });
    });
  } catch (e) {
    // 401 → məcburi token yenilə, bir dəfə cəhd et
    if (e.statusCode === 401 && allowRetry) {
      log('401: token yenilənir və yenidən qoşulur...');
      await ensureAccessToken(true, token);
      return recordAndTranscribe(opts, onChunk, false);
    }
    throw e;
  }

  ws.send(JSON.stringify({ type: 'KeepAlive' }));
  const ka = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
  }, KEEPALIVE_MS);

  // server mesajları
  let latest = '';
  let finalResolve, finalReject, finalized = false;
  const finalPromise = new Promise((resolve, reject) => {
    finalResolve = resolve; finalReject = reject;
  });
  finalPromise.catch(() => {});
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    switch (msg.type) {
      case 'TranscriptInterim':
      case 'TranscriptText':
        if (msg.data) { latest = msg.data; if (onChunk) onChunk(latest); }
        break;
      case 'TranscriptEndpoint':
        if (finalized) break; finalized = true;
        finalResolve(latest);
        break;
      case 'TranscriptError':
        if (finalized) break; finalized = true;
        finalReject(new Error(msg.description || msg.error_code || 'transkripsiya xətası'));
        break;
      case 'error':
        if (finalized) break; finalized = true;
        finalReject(new Error(msg.message || 'server xətası'));
        break;
    }
  });
  ws.on('close', () => {
    clearInterval(ka);
    if (!finalized) { finalized = true; finalReject(new Error('bağlantı bağlandı')); }
  });
  ws.on('error', () => {});

  // mikrofon + səssizlik aşkarlama
  const rec = startRecorder();
  let bytes = 0;
  const startedAt = Date.now();
  let lastVoiceAt = startedAt;
  let heardVoice = false;
  rec.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (rms(chunk) >= c.silenceRms) { lastVoiceAt = Date.now(); heardVoice = true; }
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  });
  rec.once('error', () => {});

  const maxMs = opts.seconds ? opts.seconds * 1000 : c.maxRecordMs;
  let watch;
  const how = await new Promise((resolve) => {
    process.once('SIGUSR2', () => resolve('stop'));
    process.once('SIGTERM', () => resolve('cancel'));
    process.once('SIGINT', () => resolve('cancel'));
    watch = setInterval(() => {
      const now = Date.now();
      if (now - startedAt >= maxMs) resolve('timeout');
      else if (!opts.seconds && c.silenceStopMs > 0 && now - lastVoiceAt >= c.silenceStopMs)
        resolve('silence');
    }, 250);
  });
  clearInterval(watch);
  clearInterval(ka);
  try { rec.kill('SIGKILL'); } catch {}

  if (how === 'cancel') {
    try { ws.close(); } catch {}
    return { cancelled: true };
  }
  if (how === 'silence' && !heardVoice && !latest) {
    try { ws.close(); } catch {}
    throw new Error(`${Math.round(c.silenceStopMs / 1000)}s səs eşidilmədi — dayandırıldı`);
  }
  if (bytes < MIN_BYTES) {
    try { ws.close(); } catch {}
    throw new Error('səs yazılmadı (çox qısa və ya mikrofon səssiz)');
  }

  // finalize: CloseStream göndər, son nəticəni gözlə
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
  let transcript;
  try {
    transcript = await Promise.race([
      finalPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('finalize timeout')), FINALIZE_TIMEOUT_MS)),
    ]);
  } catch (e) {
    if (latest) transcript = latest; // interim-i son nəticə kimi işlət
    else throw e;
  }
  try { ws.close(); } catch {}
  return { cancelled: false, transcript, bytes, how };
}

// ---------- paste ----------
function pasteLog(msg) {
  try { fs.appendFileSync(PASTE_LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
}

// Daemon systemd-də qalxanda WAYLAND_DISPLAY / XDG_RUNTIME_DIR olmaya bilər.
// Hər ikisini, həmçinin ydotool socket-ini özümüz tapırıq.
function sessionEnv() {
  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR) {
    const d = `/run/user/${process.getuid()}`;
    if (fs.existsSync(d)) env.XDG_RUNTIME_DIR = d;
  }
  if (!env.WAYLAND_DISPLAY && env.XDG_RUNTIME_DIR) {
    try {
      const sock = fs.readdirSync(env.XDG_RUNTIME_DIR)
        .find((f) => /^wayland-\d+$/.test(f));
      if (sock) env.WAYLAND_DISPLAY = sock;
    } catch {}
  }
  if (!env.YDOTOOL_SOCKET && env.XDG_RUNTIME_DIR) {
    const s = path.join(env.XDG_RUNTIME_DIR, '.ydotool_socket');
    if (fs.existsSync(s)) env.YDOTOOL_SOCKET = s;
  }
  return env;
}

function copyToClipboard(text, env) {
  try {
    const wl = spawn('wl-copy', [], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env });
    wl.once('error', () => {});
    wl.stdin.end(text);
    wl.unref();
    return true;
  } catch { return false; }
}

// Əvvəlki clipboard mətnini oxu (yalnız mətn; şəkil/fayl olarsa null)
function readClipboardText(env) {
  return new Promise((resolve) => {
    const run = (args) => new Promise((res) => {
      let out = Buffer.alloc(0);
      const p = spawn('wl-paste', args, { stdio: ['ignore', 'pipe', 'ignore'], env });
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} res(null); }, 1000);
      p.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
      p.once('error', () => { clearTimeout(t); res(null); });
      p.once('exit', (code) => { clearTimeout(t); res(code === 0 ? out : null); });
    });
    run(['--list-types']).then((types) => {
      const t = types ? types.toString() : '';
      if (!/^text\/plain/m.test(t) || /^image\//m.test(t)) return resolve(null);
      run(['--no-newline', '--type', 'text/plain;charset=utf-8']).then((b) =>
        resolve(b && b.length && b.length < 1024 * 1024 ? b.toString('utf8') : null));
    });
  });
}

async function pasteText(text) {
  const env = sessionEnv();
  const { restoreClipboard } = cfg();
  const previous = restoreClipboard ? await readClipboardText(env) : null;
  const copied = copyToClipboard(text, env);
  // paste-dən əvvəl wl-copy clipboard-u ələ alsın
  if (copied) await new Promise((r) => setTimeout(r, 200));
  // Ctrl+V (ydotool uinput) — Unicode hərflər (ə, ş, ö...) tam düşür.
  // ydotool `type` US keymap-dan kənar simvolları ATIR, ona görə istifadə olunmur.
  const pasted = await new Promise((resolve) => {
    const y = spawn('ydotool', ['key', '--key-delay', '60', '29:1', '47:1', '47:0', '29:0'],
      { stdio: ['ignore', 'ignore', 'pipe'], env });
    let err = '';
    y.stderr.on('data', (d) => { err += d; });
    // ydotoold cavab verməzsə proses əbədi ilişir — 3s sonra öldür (v1-də olan bug)
    const killer = setTimeout(() => {
      pasteLog('ydotool 3s cavab vermədi — öldürüldü');
      try { y.kill('SIGKILL'); } catch {}
      resolve(false);
    }, 3000);
    const done = (ok) => { clearTimeout(killer); resolve(ok); };
    y.once('error', (e) => { clearTimeout(killer); pasteLog('ydotool spawn xəta: ' + e.message); resolve(false); });
    y.once('exit', (code) => {
      pasteLog(`ydotool key exit=${code}${err ? ' stderr: ' + err.trim() : ''}` +
        ` wayland=${env.WAYLAND_DISPLAY || '-'} socket=${env.YDOTOOL_SOCKET || '-'}`);
      done(code === 0);
    });
  });
  // Bərpa: transcript Klipper tarixçəsində (Super+V) qalır, amma Ctrl+V yenə
  // istifadəçinin əvvəl kopyaladığını verir (2026-11-13 /login kodu çaşqınlığı).
  // Yalnız paste uğurlu olanda — əks halda transcript clipboard-da lazımdır.
  // Hədəf proqram datanı asinxron oxuyur, ona görə bərpadan əvvəl gözlə.
  if (pasted && previous !== null && previous !== text) {
    await new Promise((r) => setTimeout(r, 1000));
    copyToClipboard(previous, env);
    pasteLog('əvvəlki clipboard bərpa olundu');
    return 'paste-restored';
  }
  return pasted ? 'paste' : (copied ? 'clipboard' : false);
}

// ---------- state ----------
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return null; }
}
function stateAlive() {
  const s = readState();
  if (!s) return false;
  try { process.kill(s.pid, 0); return true; } catch { return false; }
}
function clearState() { try { fs.unlinkSync(STATE_PATH); } catch {} }

// ---------- rejimlər ----------
function childMain() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const c = cfg();
  notify('🎙️ Dinləyir...', 'bitirmək üçün qısayola bir dəfə daha bas' +
    (c.silenceStopMs > 0 ? ` (${Math.round(c.silenceStopMs / 1000)}s səssizlikdə avtomatik dayanır)` : ''));

  recordAndTranscribe({}, null).then(async (r) => {
    clearState();
    if (r.cancelled) { notify('🎙️ Ləğv olundu', ''); return; }
    const text = (r.transcript || '').trim();
    if (!text) { notify('🎙️ Mətn tapılmadı', 'yenidən cəhd et', true); return; }
    const how = await pasteText(text);
    const reason = r.how === 'silence' ? ' · səssizlik — avto-dayandı'
      : r.how === 'timeout' ? ' · maksimum müddət doldu' : '';
    const body = how === 'paste-restored' ? 'kursora yazıldı (Super+V tarixçəsində də var)'
      : how === 'paste' ? 'kursora yazıldı (Ctrl+V) + clipboard'
      : how === 'clipboard' ? 'clipboard-a kopyalandı (ydotool işləmədi — Ctrl+V bas)'
      : 'nə clipboard, nə paste işləmədi';
    notify('🎙️ ' + text.slice(0, 60), body + reason, how === false);
  }).catch((e) => {
    clearState();
    notify('🎙️ Xəta', String(e.message || e), true);
  });
}

async function parentMain(cmd, args) {
  switch (cmd) {
    case 'start':
    case 'toggle': {
      if (stateAlive()) {
        if (cmd === 'toggle') {
          try { process.kill(readState().pid, 'SIGUSR2'); } catch {}
          log('yazma dayandırılır...');
        } else notify('🎙️ Artıq yazırsan', '');
        return;
      }
      const child = spawn(process.execPath, [__filename, '_child'], {
        detached: true, stdio: 'ignore', env: process.env,
      });
      child.unref();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (readState()) break;
      }
      log('başladı, pid=' + (readState() || {}).pid);
      break;
    }
    case 'stop': {
      const s = readState();
      if (s) { try { process.kill(s.pid, 'SIGUSR2'); } catch {} }
      else log('aktiv yazma yoxdur');
      break;
    }
    case 'cancel': {
      const s = readState();
      if (s) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
      break;
    }
    case 'status': {
      console.log(stateAlive() ? 'yazır (pid ' + readState().pid + ')' : 'boşta');
      break;
    }
    case 'test': {
      const seconds = parseInt(args[0] || '6', 10);
      console.error(`TEST: ${seconds} san danış... (UA: ${userAgent()})`);
      try {
        const r = await recordAndTranscribe({ seconds }, (t) => process.stderr.write('\r… ' + t.slice(-70)));
        process.stderr.write('\n');
        if (r.cancelled) { console.log('(ləğv)'); return; }
        console.log('TRANSCRIPT: ' + (r.transcript || '(boş)'));
        copyToClipboard((r.transcript || '').trim(), sessionEnv());
      } catch (e) {
        console.error('XƏTA: ' + (e.message || e));
        process.exitCode = 1;
      }
      break;
    }
    case 'check-endpoint':
      process.exitCode = checkEndpoint(args[0]);
      break;
    case '_child':
      childMain();
      break;
    case 'listen':
      listenMain();
      break;
    default:
      console.log(`istifadə: ${APP} start|stop|toggle|cancel|status|test [san]|check-endpoint [versiya]|listen`);
  }
}

// ---------- check-endpoint ----------
// Claude Code yenilənəndə bundle-da protokol sətirlərinin hələ də olduğunu yoxlayır.
function checkEndpoint(version) {
  const v = version || latestClaudeVersion();
  if (!v) { console.error('Claude Code versiyası tapılmadı: ' + CLAUDE_VERSIONS); return 2; }
  const file = path.join(CLAUDE_VERSIONS, v);
  console.log(`Bundle: ${file}` + (v === KNOWN_GOOD_VERSION ? ' (yoxlanılmış versiya)' : ` (yoxlanılmış: ${KNOWN_GOOD_VERSION})`));
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { console.error('oxunmadı: ' + e.message); return 2; }
  const checks = [
    ['WS endpoint yolu', '/api/ws/speech_to_text/voice_stream'],
    ['OAuth token URL', 'platform.claude.com/v1/oauth/token'],
    ['OAuth client_id', OAUTH_CLIENT_ID],
    ['param endpointing_ms', 'endpointing_ms'],
    ['param utterance_end_ms', 'utterance_end_ms'],
    ['param use_conversation_engine', 'use_conversation_engine'],
    ['mesaj KeepAlive', 'KeepAlive'],
    ['mesaj CloseStream', 'CloseStream'],
    ['mesaj TranscriptText', 'TranscriptText'],
    ['mesaj TranscriptInterim', 'TranscriptInterim'],
    ['mesaj TranscriptEndpoint', 'TranscriptEndpoint'],
  ];
  let bad = 0;
  for (const [label, needle] of checks) {
    const ok = buf.indexOf(needle) !== -1;
    if (!ok) bad++;
    console.log(`${ok ? '✅' : '❌'} ${label.padEnd(30)} ${needle}`);
  }
  // speech_to_text ətrafındakı kontekst (dəyişiklik varsa əl ilə baxmaq üçün)
  const i = buf.indexOf('speech_to_text');
  if (i !== -1) {
    const ctx = buf.subarray(Math.max(0, i - 120), i + 200).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
    console.log('\nKontekst:\n' + ctx);
  }
  console.log(bad ? `\n⚠️  ${bad} sətir tapılmadı — protokol dəyişmiş ola bilər.` : '\nHər şey yerindədir.');
  return bad ? 1 : 0;
}

// ---------- daemon: DBus + tray ----------
function listenMain() {
  const dbus = require('dbus-next');
  const { Interface } = dbus.interface;
  const bus = dbus.sessionBus();

  class VoiceDictateIface extends Interface {
    constructor() { super(DBUS_NAME); }
    Toggle() { parentMain('toggle').catch(() => {}); }
    Cancel() { parentMain('cancel').catch(() => {}); }
  }
  VoiceDictateIface.configureMembers({
    methods: {
      Toggle: { inSignature: '', outSignature: '' },
      Cancel: { inSignature: '', outSignature: '' },
    },
  });

  bus.requestName(DBUS_NAME, 0).then(() => {
    bus.export(DBUS_PATH, new VoiceDictateIface());
    log('DBus dinləyici hazır (' + DBUS_NAME + ')');
    if (cfg().tray) startTray(bus, dbus).catch((e) => log('tray xətası: ' + e.message));
  }).catch((e) => {
    console.error('DBus:', e.message);
    process.exit(1);
  });
}

// StatusNotifierItem (KDE Plasma system tray)
async function startTray(bus, dbus) {
  const { Interface, ACCESS_READ } = dbus.interface;
  const { Variant } = dbus;
  const ICON_IDLE = 'audio-input-microphone';
  const ICON_REC = 'media-record';

  let recording = false;
  let since = 0;

  class SNI extends Interface {
    constructor() { super('org.kde.StatusNotifierItem'); }
    get Category() { return 'ApplicationStatus'; }
    get Id() { return APP; }
    get Title() { return 'Voice Dictate v2'; }
    get Status() { return recording ? 'NeedsAttention' : 'Active'; }
    get WindowId() { return 0; }
    get IconName() { return recording ? ICON_REC : ICON_IDLE; }
    get AttentionIconName() { return ICON_REC; }
    get OverlayIconName() { return ''; }
    get IconThemePath() { return ''; }
    get ItemIsMenu() { return false; }
    get Menu() { return '/NO_DBUSMENU'; }
    get ToolTip() {
      const sub = recording
        ? `Yazır… ${Math.round((Date.now() - since) / 1000)}s — sol klik: bitir, orta klik: ləğv`
        : 'Boşta — sol klik: başlat';
      return ['', [], 'Voice Dictate v2', sub];
    }
    Activate(x, y) { parentMain('toggle').catch(() => {}); }
    SecondaryActivate(x, y) { parentMain('cancel').catch(() => {}); }
    ContextMenu(x, y) { parentMain('toggle').catch(() => {}); }
    Scroll(delta, orientation) {}
    NewIcon() {}
    NewAttentionIcon() {}
    NewToolTip() {}
    NewStatus(s) { return s; }
  }
  const R = { signature: '', access: ACCESS_READ };
  SNI.configureMembers({
    properties: {
      Category: { ...R, signature: 's' }, Id: { ...R, signature: 's' },
      Title: { ...R, signature: 's' }, Status: { ...R, signature: 's' },
      WindowId: { ...R, signature: 'i' }, IconName: { ...R, signature: 's' },
      AttentionIconName: { ...R, signature: 's' }, OverlayIconName: { ...R, signature: 's' },
      IconThemePath: { ...R, signature: 's' }, ItemIsMenu: { ...R, signature: 'b' },
      Menu: { ...R, signature: 'o' }, ToolTip: { ...R, signature: '(sa(iiay)ss)' },
    },
    methods: {
      Activate: { inSignature: 'ii' },
      SecondaryActivate: { inSignature: 'ii' },
      ContextMenu: { inSignature: 'ii' },
      Scroll: { inSignature: 'is' },
    },
    signals: {
      NewIcon: {}, NewAttentionIcon: {}, NewToolTip: {},
      NewStatus: { signature: 's' },
    },
  });

  const sni = new SNI();
  bus.export('/StatusNotifierItem', sni);

  async function register() {
    try {
      const obj = await bus.getProxyObject('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher');
      await obj.getInterface('org.kde.StatusNotifierWatcher').RegisterStatusNotifierItem(DBUS_NAME);
      log('tray ikonu qeydiyyatdan keçdi');
      return true;
    } catch (e) {
      log('tray qeydiyyatı alınmadı (' + e.message + '), təkrar cəhd ediləcək');
      return false;
    }
  }

  // Watcher (plasmashell) hələ qalxmayıbsa / restart olarsa yenidən qeydiyyat
  (async () => {
    for (let i = 0; i < 60; i++) {
      if (await register()) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  try {
    const dobj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
    dobj.getInterface('org.freedesktop.DBus').on('NameOwnerChanged', (name, oldO, newO) => {
      if (name === 'org.kde.StatusNotifierWatcher' && newO) setTimeout(register, 500);
    });
  } catch {}

  // state faylını izlə → ikonu yenilə
  setInterval(() => {
    const now = stateAlive();
    if (now !== recording) {
      recording = now;
      since = now ? ((readState() || {}).startedAt || Date.now()) : 0;
      sni.NewIcon();
      sni.NewStatus(sni.Status);
      sni.NewToolTip();
    } else if (recording) {
      sni.NewToolTip(); // saniyə sayğacı
    }
  }, 500);
}

const [, , cmd = 'toggle', ...rest] = process.argv;
parentMain(cmd, rest).catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
