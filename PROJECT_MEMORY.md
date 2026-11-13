# voice-dictate — Layihə yaddaş kitabçası

> **Bu faylın məqsədi:** yeni agent session-da konteksti bərpa etmək.
> Yeni session-da de: **"`~/voice-dictate-README.md` faylını oxu — voice-dictate layihəsinə davam edək"**

---

## 1. Layihənin məqsədi

İstifadəçi (patriot, Arch Linux, KDE Plasma 6.8 Wayland, PipeWire) istəyirdi:
**istənilən proqramda Ctrl+Space basıb danışsın, Anthropic-in (claude.ai / Claude Code-un) diktə sistemi səsini yazıya çevirsin, mətn kursorun yerinə + clipboard-a düşsün.** Pulsuz, abunəliyi var (subscription: max).

B variantı (brauzer avtomatizması) atıldı — pəncərə fokusunu oğurlamalıdır, A variantı (direct protocol) tam bu ehtiyacı qarşılayır.

---

## 2. Kəşf edilmiş protokol (Claude Code 2.1.322 bundle-dan reverse-engineering)

Bundle: `/home/patriot/.local/share/claude/versions/2.1.322` (342MB bun-compiled icra faylı).
Yol: `grep -aob "speech_to_text"` → offset → `dd` ilə konteksti çıxarmaq.

**Endpoint:** `wss://api.anthropic.com/api/ws/speech_to_text/voice_stream?encoding=linear16&sample_rate=16000&channels=1&endpointing_ms=300&utterance_end_ms=1000&language=<xx>&use_conversation_engine=true`

**Headers:** `Authorization: Bearer <claude.ai OAuth accessToken>`, `User-Agent: claude-cli/2.1.322 (external, cli)`, `x-app: cli`

**Göndərilən mesajlar:**
- Qoşulanda + hər 5 san: `{"type":"KeepAlive"}`
- Audio: **raw PCM s16le, 16kHz, mono** — binary WS frame-lər, realtime tempoda
- Bitirəndə: `{"type":"CloseStream"}`

**Gələn mesajlar (JSON text):**
- `{"type":"TranscriptInterim"|"TranscriptText","data":"..."}` — canlı mətn
- `{"type":"TranscriptEndpoint"}` — finalize
- `{"type":"TranscriptError","description":...}` / `{"type":"error","message":...}`

**Dillər:** `az` serverdə rədd olunur ("harmonic provider does not support the requested language"). `tr` ilə **azərbaycanca əla yazır** (canlı testdə təsdiq). Konfiq: `~/.config/voice-dictate.json` → `{"language":"tr"}`.

---

## 3. Token / OAuth (ÇOX VACİB — bug'lardan dərslər)

- Token: `~/.claude/.credentials.json` → `.claudeAiOauth.accessToken` (+ refreshToken, expiresAt)
- **expiresAt ISO string DEYİL, millisaniyə rəqəmidir!** (`Date.parse` → NaN → "müddəti bitib" səhv qərarı)
- **Yeniləmə (doğru format, 200 OK təsdiqli):**
  - `POST https://platform.claude.com/v1/oauth/token` (YOX — console.anthropic.com köhnəlib, Cloudflare 403/1010 verir)
  - JSON body: `{grant_type:"refresh_token", refresh_token, client_id:"9d1c250a-e61b-44d9-88ed-5944d1962f5e", scope:"user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins"}`
  - (Köhnə client_id `...44d6-9bde...` 400 verir; bundle-dan 2026-cı dəyər: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`)
  - Cavab: `access_token, refresh_token, expires_in, refresh_token_expires_in, scope, ...`
  - Yazma **atomik** olmalıdır: tmp fayla yaz → `os.replace` (refresh_token rotasiya olunur, itirsən → yenidən `/login`)
- Token 401 verərsə: daemon məcburi yeniləyib bir dəfə yenidən qoşulur
- Claude Code özü də tokeni yeniləyir — onu işlətəndə fayl təzələnir

---

## 4. Arxitektura (hansı yollarla qurulub)

```
Ctrl+Space (fiziki) 
  → KWin script registerShortcut (kompozitor daxili, global qısayol)
  → callDBus org.local.VoiceDictate / Toggle
  → systemd voice-dictate.service (Node daemon, dbus-next)
  → parentMain('toggle') → detached child spawn
  → pw-record (16k/s16/mono/raw) → WS-ə realtime stream
  → CloseStream → final transcript gözlə (6s timeout, interim fallback)
   → wl-copy + ydotool key Ctrl+V paste (kursora, Unicode-safe) + notify-send
```

**Fayllar:**
| Yer | Nədir |
|---|---|
| `~/.local/share/voice-dictate/voice-dictate.js` | Əsas proqram (Node 24, `ws` + `dbus-next` npm paketləri eyni qovluqdadır) |
| `~/.local/bin/voice-dictate` | symlink, CLI: `start\|stop\|toggle\|cancel\|status\|test <san>\|listen` |
| `~/.config/systemd/user/voice-dictate.service` | DBus dinləyici daemon (login-də avtomatik) |
| `~/.config/systemd/user/voice-dictate-hotkey.service` | oneshot, graphical-session.target: KWin scripti yükləyib `start()` edir (90 cəhd × 2s) |
| `~/.local/bin/voice-dictate-hotkey-load.sh` | hotkey service-in ExecStart skripti, log: `~/.cache/voice-dictate-hotkey.log` |
| `~/.local/share/kwin/scripts/voicedictate/contents/code/main.js` | KWin script: `registerShortcut("Voice Dictate Toggle", ..., "Ctrl+Space", callDBus Toggle)` + Cancel (qısayolu boşdur, Shortcuts-də təyin olunur) |
| `~/.local/share/kwin/scripts/voicedictate/metadata.json` | `{"KPackageStructure":"KWin/Script","KPlugin":{...}}` (metadata.desktop da var) |
| `~/.config/kwinrc` → `[Plugins] voicedictateEnabled=true` | avto-yükləmə işarəsi |
| `~/.local/share/dbus-1/services/org.local.VoiceDictate.service` | DBus aktivasiya (daemon ölübsə çağırışda özü qalxır) |
| `~/.config/voice-dictate.json` | dil konfiqi |

**State/clearing:** `~/.cache/voice-dictate.state.json` (pid); SIGUSR2 = finalize, SIGTERM/SIGINT = cancel.

---

## 5. Kritik dərslər (bug şərhi)

1. **KWin script:** `loadScript()` → `isScriptLoaded=true` AMMA işləmək üçün **`Scripting.start()` LAZIMDIR** (reboot-dan sonra qısayol niyə işləmədi — məhz bu idi).
2. `kglobalshortcutsrc`-ə [Services] girişi CLI-dan qeydiyyatdan keçmir — KWin script yolu seçildi.
3. `wtype` yoxdur (sudo parol tələb edirdi) → **ydotool** işlədilir (`ydotoold` daemonu sistemdə işləyir). uinput vasitəsilə KDE Wayland-da işləyir.
4. `pw-record --raw -` stdout-a raw PCM verir (ffmpeg pulse fallback var).
5. dbus-next API: `dbus.interface.Interface` sinfini extend et, `constructor(){super('org.local.VoiceDictate')}`, `configureMembers({methods:{Toggle:{inSignature:'',outSignature:''}}})`, `bus.export(path, instance)`.
6. systemd user env-də WAYLAND_DISPLAY var — amma daemon Plazma env-i set etməzdən ƏVVƏL qalxarsa proses env-ində olmur → `wl-copy` səssizcə işləmir (clipboard boş qalır, notification DBus-dan işlədiyi üçün səhv görünmür). Həll: `waylandEnv()` — `XDG_RUNTIME_DIR`-də `wayland-*` socket-i avtomatik tapır (2026-11-13).
7. **ydotool `type` qeyri-ASCII hərfləri ATIR** (ə, ş, ö, ü, ı, ç — US keymap limiti; "Sən→Sn", "yaxşı→yax"). Həll: wl-copy + `ydotool key 29:1 47:1 47:0 29:0` (Ctrl+V paste) — Unicode tam düşür. `type` yalnız fallback; paste-dən əvvəl 200ms gözlə (wl-copy clipboard-u ələ alsın).

---

## 6. Nə ALINIB (hazır, test olunub)

- ✅ Protokol tam yenidən quruldu, canlı transkripsiya işləyir (azərbaycanca, `tr` parametrlə)
- ✅ Token yeniləmə düzəldilib (200 OK), atomik saxlanma, 401-avto-retry
- ✅ Ctrl+Space qısayolu (KWin script + DBus daemon), login-dən sonra avtomatik bərpa
- ✅ Clipboard + kursora yazma (**Ctrl+V paste**, ydotool), notifications
- ✅ Toggle rejimi (bas→danış→bas), test rejimi, cancel, status
- ✅ Unicode paste fix (2026-11-13): ydotool type ə/ş/ö/ü/ı/ç atırdı → Ctrl+V paste; WAYLAND_DISPLAY fallback `waylandEnv()`

## 7. Nə QALIB (gələcək ideyalar)

- ⬜ `wtype` quraşdırmaq (daha təmiz paste; `sudo pacman -S wtype` — userdən soruş) — hazırda ydotool işləyir, vacib deyil
- ⬜ Səssizlik avto-dayandırma (15s), 2 dəq limit — server özü bağlayır, client həll etmir
- ⬜ System tray göstəricisi / recording pəncərəsi
- ⬜ Claude Code update olarsa endpoint dəyişə bilər → yenidən `grep -aob "speech_to_text"` ilə yoxla (bu README-dəki protokol bölməsi kömək edər)
- ⬜ Qısayolu dəyişmək istəsə: Shortcuts-də "Voice Dictate Toggle" (KWin script qeydiyyatı) və ya main.js-də keySequence
- ⬜ **Qeyri-rəsmi istifadədir** — Anthropic ToS riski istifadəçiyə məxsusdur, şəxsi istifadə üçün

## 8. Test əmrləri

```bash
voice-dictate test 15        # terminalda yaz, transcript + clipboard-a
voice-dictate status         # yazır/boşta
voice-dictate toggle         # manual başlat/dayandır
voice-dictate cancel
systemctl --user status voice-dictate voice-dictate-hotkey
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded voicedictate
ydotool key 29:1 57:1 57:0 29:0   # Ctrl+Space simulyasiyası (test üçün)
cat ~/.cache/voice-dictate-hotkey.log
```

## 9. Yeni session-da nə deməli

> **"`~/voice-dictate-README.md` faylını oxu — voice-dictate layihəsinə davam edək"**

Sonra istədiyini əlavə et (tray, dil dəyişmə, wtype, və s.).
