#!/usr/bin/env node
/*
 * voice-dictate — Anthropic-in diktə sistemindən (Claude Code-la eyni endpoint)
 * istənilən yerdə istifadə: qısayol → danış → mətn kursora + clipboard-a.
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
 * Komandalar: start | stop | toggle | cancel | test <san> | status
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const CFG_PATH = path.join(os.homedir(), '.config', 'voice-dictate.json');
const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const STATE_PATH = path.join(os.homedir(), '.cache', 'voice-dictate.state.json');
const WS_BASE = 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_SCOPE = 'user:profile user:inference user:sessions:claude_code ' +
  'user:mcp_servers user:file_upload user:plugins';
const UA = 'claude-cli/2.1.322 (external, cli)';
const KEEPALIVE_MS = 5000;
const MAX_RECORD_MS = 120000;
const FINALIZE_TIMEOUT_MS = 6000;
const MIN_BYTES = 8000; // ~0.25 saniyə səs

function cfg() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch { return {}; }
}
function saveCfg(c) {
  try { fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2)); } catch {}
}
function log(...a) { console.log('[voice-dictate]', ...a); }

function notify(summary, body, urgent) {
  try {
    spawn('notify-send', ['-a', 'voice-dictate',
      ...(urgent ? ['-u', 'critical'] : ['-u', 'normal']),
      summary, body || ''], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

// ---------- token ----------
function readOauth() {
  const c = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  const o = c.claudeAiOauth || c;
  if (!o.accessToken) throw new Error('claude.ai token tapılmadı');
  return { file: c, oauth: o };
}

async function ensureAccessToken(force) {
  const { file, oauth } = readOauth();
  const exp = typeof oauth.expiresAt === 'number' ? oauth.expiresAt
    : (Date.parse(oauth.expiresAt) || 0);
  if (!force && exp > Date.now() + 60000) return oauth.accessToken;
  log('token müddəti bitib, yenilənir...');
  if (!oauth.refreshToken) return oauth.accessToken;
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
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
    file.claudeAiOauth = oauth;
    const tmp = CRED_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CRED_PATH);
    log('token yeniləndi');
    return oauth.accessToken;
  } catch (e) {
    log('token yenilənmədi (' + e.message + '), köhnə token işlədilir');
    return oauth.accessToken;
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
    // fallback: ffmpeg (pulse vasitəsilə pipewire)
    child = spawn('ffmpeg', ['-f', 'pulse', '-i', 'default',
      '-ar', '16000', '-ac', '1', '-f', 's16le', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    hook(child);
  });
  function hook(c) {
    c.once('error', () => { failed = true; });
  }
  hook(child);
  return child;
}

// ---------- əsas: yaz + transkripsiya ----------
async function recordAndTranscribe(opts, onChunk, allowRetry = true) {
  const c = cfg();
  const language = process.env.VD_LANG || c.language || 'tr';
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
  const url = `${WS_BASE}?${params}`;

  const ws = new WebSocket(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': UA,
      'x-app': 'cli',
      'anthropic-client-platform': 'Linux',
    },
    handshakeTimeout: 10000,
  });

  let openError = null;
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', (e) => { openError = e; reject(e); });
    ws.once('unexpected-response', (req, res) => {
      openError = new Error(`WS rədd edildi: HTTP ${res.statusCode}` +
        (res.headers['cf-mitigated'] ? ' (Cloudflare)' : ''));
      openError.statusCode = res.statusCode;
      reject(openError);
    });
  });
  // 401 → məcburi token yenilə, bir dəfə cəhd et
  if (openError && openError.statusCode === 401 && allowRetry) {
    log('401: token yenilənir və yenidən qoşulur...');
    await ensureAccessToken(true);
    return recordAndTranscribe(opts, onChunk, false);
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
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    switch (msg.type) {
      case 'TranscriptInterim':
      case 'TranscriptText':
        if (msg.data) { latest = msg.data; if (onChunk) onChunk(latest); }
        break;
      case 'TranscriptEndpoint': {
        if (finalized) break; finalized = true;
        finalResolve(latest);
        break;
      }
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

  // mikrofon
  const rec = startRecorder();
  let bytes = 0;
  rec.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  });
  rec.once('error', () => {});
  rec.once('exit', () => {}); // stop-da biz öldürürük

  const stopSignal = () => new Promise((resolve) => {
    process.on('SIGUSR2', () => resolve('stop'));
    process.on('SIGTERM', () => resolve('cancel'));
    process.on('SIGINT', () => resolve('cancel'));
  });

  const timeout = new Promise((res) =>
    setTimeout(() => res('timeout'), opts.seconds ? opts.seconds * 1000 : MAX_RECORD_MS));

  const how = await Promise.race([stopSignal(), timeout]);
  clearInterval(ka);

  if (rec && !rec.killed) { try { rec.kill('SIGKILL'); } catch {} }

  if (how === 'cancel') {
    try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch {}
    finalReject = finalReject || (() => {});
    return { cancelled: true };
  }

  // finalize: CloseStream göndər, son nəticəni gözlə
  if (bytes < MIN_BYTES) {
    try { ws.close(); } catch {}
    throw new Error('səs yazılmadı (çox qısa və ya mikrofon səssiz)');
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
  let transcript;
  try {
    transcript = await Promise.race([
      finalPromise,
      new Promise((_, rej) => setTimeout(() =>
        rej(new Error(latest ? 'finalize timeout (interim saxlanıldı)' : 'finalize timeout')), FINALIZE_TIMEOUT_MS)),
    ]);
  } catch (e) {
    if (latest) transcript = latest; // interim-i son nəticə kimi işlət
    else throw e;
  }
  try { ws.close(); } catch {}
  return { cancelled: false, transcript, bytes };
}

// ---------- paste ----------
// Daemon systemd-də qalxanda WAYLAND_DISPLAY olmaya bilər (Plazma sonra set edir).
// XDG_RUNTIME_DIR-də wayland-* socket-i axtarıb env-i tamamlayırıq.
function waylandEnv() {
  const env = { ...process.env };
  if (!env.WAYLAND_DISPLAY && env.XDG_RUNTIME_DIR) {
    try {
      const sock = fs.readdirSync(env.XDG_RUNTIME_DIR)
        .find((f) => f.startsWith('wayland-') && !f.endsWith('.lock'));
      if (sock) env.WAYLAND_DISPLAY = sock;
    } catch {}
  }
  return env;
}

async function pasteText(text) {
  const env = waylandEnv();
  let copied = false;
  // həmişə clipboard-a (wl-copy prosesi clipboard sahibi kimi canlı qalmalıdır)
  try {
    const wl = spawn('wl-copy', [], {
      detached: true, stdio: ['pipe', 'ignore', 'ignore'], env,
    });
    wl.stdin.end(text);
    wl.unref();
    wl.once('error', () => {});
    copied = true;
  } catch {}
  // paste-ə qədər wl-copy-nin clipboard-u ələ almasına vaxt ver
  if (copied) await new Promise((r) => setTimeout(r, 200));
  // Ctrl+V paste (ydotool uinput) — Unicode hərflər (ə, ş, ö...) belə düşür.
  // ydotool type US keymap-dan kənar simvolları ATIR, ona görə paste birinci yoldur.
  const pasted = await new Promise((resolve) => {
    const y = spawn('ydotool', ['key', '--key-delay', '60', '29:1', '47:1', '47:0', '29:0'],
      { stdio: 'ignore', env });
    y.once('error', () => resolve(false));
    y.once('exit', (code) => resolve(code === 0));
  });
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
  const isTest = process.env.VD_TEST === '1';
  const seconds = parseInt(process.env.VD_SECONDS || '0', 10) || 0;
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  notify('🎙️ Dinləyir...', isTest ? `test: ${seconds}s` : 'bitirmək üçün qısayola bir dəfə daha bas');

  recordAndTranscribe({}, null).then((r) => {
    clearState();
    if (!r) return;
    if (r.cancelled) { notify('🎙️ Ləğv olundu', ''); return; }
    const text = (r.transcript || '').trim();
    if (!text) { notify('🎙️ Mətn tapılmadı', 'yenidən cəhd et', true); return; }
    if (isTest) {
      process.stdout.write(text + '\n');
      notify('🎙️ ' + text.slice(0, 60), 'clipboard-a kopyalandı');
      return;
    }
    pasteText(text).then((how) => {
      const body = how === 'paste' ? 'kursora yazıldı (Ctrl+V) + clipboard'
        : how === 'clipboard' ? 'clipboard-a kopyalandı (ydotool işləmədi — Ctrl+V bas)'
        : 'nə clipboard, nə paste işləmədi';
      notify('🎙️ ' + text.slice(0, 60), body, how === false);
    });
  }).catch((e) => {
    clearState();
    notify('🎙️ Xəta', String(e.message || e), true);
    if (isTest) { console.error('ERROR: ' + (e.message || e)); process.exitCode = 1; }
  });
}

async function parentMain(cmd, args) {
  switch (cmd) {
    case 'start':
    case 'toggle': {
      if (stateAlive()) {
        if (cmd === 'toggle') {
          const s = readState();
          try { process.kill(s.pid, 'SIGUSR2'); } catch {}
          log('yazma dayandırılır...');
        } else notify('🎙️ Artıq yazırsan', '');
        return;
      }
      const child = spawn(process.execPath, [__filename, '_child'], {
        detached: true, stdio: 'ignore',
        env: { ...process.env, VD_TEST: '0' },
      });
      child.unref();
      // state faylının gəlməsini gözlə
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (readState()) break;
      }
      log('başladı, pid=' + (readState() || {}).pid);
      break;
    }
    case 'stop': {
      const s = readState();
      if (s) { try { process.kill(s.pid, 'SIGUSR2'); } catch {} clearState(); }
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
      const token = await ensureAccessToken().catch(() => null);
      if (!token) { console.error('token yoxdur'); process.exit(1); }
      console.error(`TEST: ${seconds} san danış...`);
      try {
        const r = await recordAndTranscribe({ seconds }, null);
        if (r.cancelled) { console.log('(ləğv)'); return; }
        console.log('TRANSCRIPT: ' + (r.transcript || '(boş)'));
        try {
          const wl = spawn('wl-copy', [], { stdio: ['pipe', 'ignore', 'ignore'], env: waylandEnv() });
          wl.stdin.end((r.transcript || '').trim());
        } catch {}
      } catch (e) {
        console.error('XƏTA: ' + (e.message || e));
        process.exitCode = 1;
      }
      break;
    }
    case '_child':
      childMain();
      break;
    case 'listen':
      listenMain();
      break;
    default:
      console.log('istifadə: voice-dictate start|stop|toggle|cancel|status|test [san]');
  }
}

function listenMain() {
  const dbus = require('dbus-next');
  const bus = dbus.sessionBus();
  const name = 'org.local.VoiceDictate';

  class VoiceDictateIface extends dbus.interface.Interface {
    constructor() { super('org.local.VoiceDictate'); }
    Toggle() { parentMain('toggle').catch(() => {}); }
    Cancel() { parentMain('cancel').catch(() => {}); }
  }
  VoiceDictateIface.configureMembers({
    methods: {
      Toggle: { inSignature: '', outSignature: '' },
      Cancel: { inSignature: '', outSignature: '' },
    },
  });

  bus.requestName(name, 0).then(() => {
    bus.export('/org/local/VoiceDictate', new VoiceDictateIface());
    log('DBus dinləyici hazır (' + name + ')');
  }).catch((e) => {
    console.error('DBus:', e.message);
    process.exit(1);
  });
}

const [, , cmd = 'toggle', ...rest] = process.argv;
parentMain(cmd, rest).catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
