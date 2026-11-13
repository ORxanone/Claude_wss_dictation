# voice-dictate — Layihə yaddaş kitabçası

> **Bu faylın məqsədi:** yeni agent session-da konteksti bərpa etmək.
> Yeni session-da de: **"`~/voice-dictate-README.md` faylını oxu — voice-dictate layihəsinə davam edək"**
>
> **AKTİV VERSİYA: v2** (`~/voice-dictate-v2`, git `v2` branch, CLI `voice-dictate2`, qısayol `Ctrl+Space`) — bax **§10**.
> **v1 SÖNDÜRÜLÜB** (2026-11-13, səbəb: təhlükəsiz olmayan token yeniləməsi, §3b). Faylları yerindədir.
> Konfiq ehtiyat nüsxəsi: `~/voice-dictate-backup-20261113-1420/`.
>
> **v1-ə geri qayıtmaq** (lazım olsa):
> ```bash
> ~/voice-dictate-v2/uninstall.sh
> mv ~/.local/share/dbus-1/services/org.local.VoiceDictate.service{.disabled,}
> kwriteconfig6 --file kwinrc --group Plugins --key voicedictateEnabled true
> systemctl --user enable --now voice-dictate voice-dictate-hotkey
> ```

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

### 3a. Claude Code-un öz yeniləmə protokolu (2.1.323 bundle-dan, 2026-11-13 araşdırıldı)
- Bitməsinə **5 dəq** qalmış yeniləyir (`uI`: `now+300000 >= expiresAt`).
- **İki kilid** (proper-lockfile, `mkdir` əsaslı, `stale:60000, update:5000`):
  1. `~/.claude/.oauth_refresh.lock`  2. `<realpath ~/.claude>.lock` (= `~/.claude.lock`).
  Tutulubsa 5 dəfə 1–2s gözləyir; mtime dəyişmirsə sahibi ölü sayır.
- Kilid altında faylı yenidən oxuyur: accessToken dəyişibsə → "race resolved", yeniləmir.
- Yazma **CAS**-dır: yalnız fayldakı refreshToken göndərdiyinə bərabərdirsə yazır.
- **`invalid_grant` alanda (`OHo`) diskdəki accessToken+refreshToken-i SİLİR** → `/login` tələb olunur.
  Yəni kənar proses eyni refresh_token-i Claude Code ilə eyni anda işlətsə, Claude Code-un girişi itə bilər.
- `claude auth status` tokeni YENİLƏMİR (delegasiya üçün yararsızdır).

### 3b. v2-nin token qaydası (bu protokola qoşulur)
- Token bitməsinə >30s qalıbsa — yalnız OXUYUR (Claude Code açıqdırsa həmişə ilk o yeniləyir).
- Bitirsə: Claude Code-un **hər iki kilidini** eyni qaydada götürür (mtime hər 5s), kilid altında
  yenidən oxuyur, CAS ilə atomik yazır (mode qorunur, mcpOAuth və s. qalır), scopes/clientId fayldan.
- Uğursuzluqda faylda **heç nə dəyişmir/silinmir**, istifadəçiyə bildiriş.
- Kilid 20s məşğuldursa — yeniləmir, fayldakı təzə tokeni gözləyir.
- Bundle-da kilid protokolu tanınmırsa (Claude Code dəyişib) — **yeniləmir** (fail-safe), versiya üzrə keşlənir.
- Testlər: `NODE_PATH=... node test/token.test.js` (saxta HOME + saxta fetch, 8 ssenari).
- ⚠️ **v1-in token kodu bu qorumaya MALİK DEYİL** (kilidsiz, CAS-sız, 60s həddi, 401-də məcburi yeniləmə).

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
8. **ydotool client socket-i:** default `$XDG_RUNTIME_DIR/.ydotool_socket`; `XDG_RUNTIME_DIR` yoxdursa `/tmp/.ydotool_socket`-a baxır → uğursuz. Daemon child-də env-i tamamla (v2-də `sessionEnv()`).
9. **ydotool bəzən cavab vermir** → client prosesi əbədi qalır, diktə child-i paste-də ilişir (2026-11-13 real hadisə). Həll (v2): 3s timeout, sonra kill.
10. **Diktə clipboard-u əvəz edir — istifadəçini çaşdıra bilər** (v2-də həll: `restoreClipboard`): diktədən sonra Ctrl+V transcript verir, istifadəçi başqa mətn kopyalayana qədər belə. Login kodu kimi vacib kopyalama arxasında diktə bitibsə, kopyalamanın təsdiqini yoxla (`wl-paste`). (2026-11-13: /login kod paste-i köhnə transcript ilə səhv düşdü)

---

## 6. Nə ALINIB (hazır, test olunub)

- ✅ Protokol tam yenidən quruldu, canlı transkripsiya işləyir (azərbaycanca, `tr` parametrlə)
- ✅ Token yeniləmə düzəldilib (200 OK), atomik saxlanma, 401-avto-retry
- ✅ Ctrl+Space qısayolu (KWin script + DBus daemon), login-dən sonra avtomatik bərpa
- ✅ Clipboard + kursora yazma (**Ctrl+V paste**, ydotool), notifications
- ✅ Toggle rejimi (bas→danış→bas), test rejimi, cancel, status
- ✅ Unicode paste fix (2026-11-13): ydotool type ə/ş/ö/ü/ı/ç atırdı → Ctrl+V paste; WAYLAND_DISPLAY fallback `waylandEnv()`

## 7. Nə QALIB (gələcək ideyalar)

- ➖ (lazım deyil — Ctrl+V paste Unicode-u həll edir) `wtype` quraşdırmaq (daha təmiz paste; `sudo pacman -S wtype` — userdən soruş) — hazırda ydotool işləyir, vacib deyil
- ✅ (v2) Səssizlik avto-dayandırma (silenceStopMs) + maxRecordMs
- ✅ (v2) System tray ikonu (StatusNotifierItem, dbus-next)
- ✅ (v2) **Claude Code yeniləmələri avtomatik izlənir:** daemon login-dən 15s sonra, hər 30 dəq və `~/.local/share/claude/versions`-a yeni versiya yazılanda bundle-ı yoxlayır (versiya başına bir dəfə, keşlə). Protokol yerindədirsə "Claude Code X yoxlandı ✅", dəyişibsə kritik bildiriş (hansı sətirlər itib). Kilid sətirləri itibsə token avto-yeniləmə özü söndürülür. Diktə server xətası verəndə bildirişə `check-endpoint` ipucu əlavə olunur. Əl ilə: `voice-dictate2 check-endpoint [versiya]`.
  - **Avtomatik DÜZƏLMİR:** endpoint həqiqətən dəyişsə, yeni dəyərləri bundle-dan tapmaq lazımdır (§2: `grep -aob "speech_to_text"`, §3a). Bu session-a qayıdıb davam etmək kifayətdir.
  - Server tərəfdə (Claude Code yenilənmədən) dəyişiklik lokal yoxlama ilə tutula bilməz — onda yalnız diktə xəta bildirişi görünür.
- ✅ (v2) `VD_SHORTCUT=... ./install.sh`. Qısayolu dəyişmək istəsə: Shortcuts-də "Voice Dictate Toggle" (KWin script qeydiyyatı) və ya main.js-də keySequence
11. **Token yarışı — ✅ HƏLL OLUNUB (v2, 2026-11-13, ətraflı §3a/§3b).** Problem: refresh_token rotasiya olunur; eyni köhnə refresh_token-i iki proses (Claude Code, Zed claude-acp agentləri, bizim daemon) işlədərsə biri `invalid_grant` alır, Claude Code isə bu halda diskdəki tokenləri SİLİR → `/login`. Hazırkı həll (kodda yoxlanılıb, 8 test): (a) token bitməsinə >30s qalıbsa yalnız OXU — Claude Code 5 dəq qalmış özü yeniləyir; (b) bitirsə Claude Code-un ÖZ iki kilidini götür (`~/.claude/.oauth_refresh.lock`, `~/.claude.lock`); (c) kilid altında faylı yenidən oxu, token dəyişibsə onu işlət; (d) 401-də fayldakı token fərqlidirsə yeniləmədən onu işlət; (e) CAS + ən təzə faylla birləşdirərək atomik yaz (mcpOAuth və s. qalır, mode qorunur); (f) uğursuzluqda faylda HEÇ NƏ dəyişmə, aydın bildiriş ver; (g) kilid 20s məşğuldursa Claude Code-un yazdığı təzə tokeni götür; (h) Claude Code kilid protokolunu dəyişibsə — yeniləmə (fail-safe). Köhnə ilkin həll (öz `~/.cache/voice-dictate2.refresh.lock` kilidi) SİLİNİB — onu Claude Code görmürdü.
13. **Səs olmayanda server mətn göndərmədən bağlanır** (CloseStream → close 1000, TranscriptEndpoint YOX). Bu xəta deyil — boş transcript kimi qəbul et (v2-də düzəldilib; əvvəl "bağlantı bağlandı" xətası çıxırdı).
14. Qısayol köçürmə: köhnə qısayolu `qdbus6 org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel.unregister kwin "<ad>"` ilə azad et, yoxsa yeni script eyni düyməni ala bilmir.
12. `~/.config/kwinrc`-dəki `voicedictateEnabled=true` girişi KWin tərəfindən silinə bilər — problem deyil, hotkey servisi hər login-də `loadScript`+`start` edir.

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

---

## 11. Veb backend (git `web-backend` branch) — ABUNƏLİKSİZ

Claude Code tokeni (Pro/Max) olmadan, **pulsuz claude.ai hesabı** ilə işləyir. Brauzerdən `sessionKey`
cookie götürülür. Endpoint eynidir, yalnız host `claude.ai`, giriş cookie ilədir.

**Kəşf (2026-11-13, canlı test — həm abunəli, həm pulsuz hesabla təsdiq):**
- `wss://claude.ai/api/ws/speech_to_text/voice_stream?...&stt_provider=deepgram-nova3&keepalive_ack=true&client_platform=web_claude_ai&organization_uuid=<org>`
- Başlıqlar: `Origin: https://claude.ai`, `Cookie: sessionKey=sk-ant-sid02-...`, brauzer `User-Agent`. Cloudflare cookie-ləri (cf_clearance, __cf_bm) LAZIM DEYİL.
- Mesaj protokolu eynidir (KeepAlive/CloseStream/TranscriptText/TranscriptEndpoint); əlavə `KeepAliveAck` gəlir.
- `az` yenə rədd (harmonic provider), `tr` azərbaycancanı düzgün yazır.
- **Pulsuz hesabda işləyir** (test: "Deməli belə, səndən bir iş görəcəyik..." düzgün transkripsiya).

**Konfiq:** `~/.config/voice-dictate2.web.json` = `{"sessionKey":"sk-ant-sid02-...","organizationUuid":"<lastActiveOrg>"}`, **0600**.
`~/.config/voice-dictate2.json` → `"backend":"web"`. Repoya düşmür (`.gitignore: *.web.json`).

**Əmrlər:**
```bash
voice-dictate2 web-login      # sessionKey + organizationUuid soruşur (tarixçəyə düşmür), 0600 yazır
voice-dictate2 backend web    # backend-i dəyiş; sonra: systemctl --user restart voice-dictate2
voice-dictate2 backend        # cari backend
voice-dictate2 web-check      # cookie-ni yoxla (səssiz 2s qoşulma)
voice-dictate2 backend anthropic   # Claude Code tokeninə qayıt
```

**İki backend arasında keçid:**
| Hədəf | Addımlar |
|---|---|
| Claude Code tokeni (Pro/Max) → **anthropic** | `voice-dictate2 backend anthropic && systemctl --user restart voice-dictate2` |
| Pulsuz claude.ai → **web** | (ilk dəfə) `voice-dictate2 web-login` → sonra `voice-dictate2 backend web && systemctl --user restart voice-dictate2` |

**Vacib fərqlər / dərslər:**
- `sessionKey` hesabın TAM açarıdır (token-dən riskli). 0600 faylda, repoya düşmür.
- `sessionKey` müddəti bitir, avto-yenilənmir → `web-login` ilə yenidən yaz. Brauzerdə çıxış edilsə köhnəlir (401/403 → aydın mesaj).
- Web backend Claude Code bundle-ından asılı deyil → `watchClaudeUpdates`/`check-endpoint` web rejimində işləmir.
- Testlər (şəbəkəsiz): `node test/web.test.js` (6 ssenari — url/cookie/icazə/sızma).
- ⚠️ Qeyri-rəsmi istifadə, ToS riski istifadəçiyə aiddir (hər iki backend üçün).

## 10. v2 (`~/voice-dictate-v2`, git `v2` branch)

v1-in snapşotundan törəyib; v1-ə toxunmur. Quraşdırma: `cd ~/voice-dictate-v2 && ./install.sh` (silmək: `./uninstall.sh`).

| v1 | v2 |
|---|---|
| CLI `voice-dictate` | `voice-dictate2` |
| `~/.local/share/voice-dictate/` | `~/.local/share/voice-dictate2/` |
| DBus `org.local.VoiceDictate` | `org.local.VoiceDictate2` (+ `/StatusNotifierItem`) |
| `voice-dictate.service`, `voice-dictate-hotkey.service` | `voice-dictate2.service`, `voice-dictate2-hotkey.service` |
| KWin script `voicedictate`, `Ctrl+Space` | `voicedictate2`, `Ctrl+Alt+Space` (`VD_SHORTCUT=... ./install.sh`) |
| `~/.config/voice-dictate.json` | `~/.config/voice-dictate2.json` (yoxdursa v1-inkini oxuyur) |
| `~/.cache/voice-dictate.state.json` | `~/.cache/voice-dictate2.state.json`, `voice-dictate2-paste.log` |

**v2 konfiqi:** `{"language":"tr","silenceStopMs":15000,"maxRecordMs":120000,"silenceRms":400,"tray":true,"restoreClipboard":true,"clientVersion":""}`

**v2-də nə var:**
- Tray ikonu (StatusNotifierItem, dbus-next): sol klik başlat/bitir, orta klik ləğv, tooltip-də saniyə. Plasma-da qeydiyyat təsdiqlənib.
- Səssizlik avto-dayandırma (RMS < `silenceStopMs` müddətində) + `maxRecordMs`; heç səs eşidilməyibsə heç nə yapışdırmır.
- `voice-dictate2 check-endpoint [versiya]` — bundle-da protokol sətirlərini yoxlayır (2.1.323-də hamısı ✅).
- UA versiyası `~/.local/share/claude/versions`-dan avtomatik.
- `sessionEnv()`: XDG_RUNTIME_DIR / WAYLAND_DISPLAY / YDOTOOL_SOCKET avtomatik.
- ydotool 3s timeout (child ilişmir).
- `restoreClipboard`: uğurlu paste-dən 1s sonra əvvəlki clipboard mətni qaytarılır; transcript Super+V tarixçəsində qalır. Paste alınmayıbsa transcript clipboard-da qalır.
- Token yarışına qarşı qoruma — Claude Code-un öz kilid protokoluna qoşulur (§3a, §3b).
- Servis sistem node-u (`/usr/bin/node`, ≥20) ilə işləyir — nvm versiya dəyişəndə sınmır.

**Quraşdırılıb və yoxlanılıb (2026-11-13):** servis `/usr/bin/node` ilə, KWin script, `Ctrl+Space` (ydotool simulyasiyası ilə)
→ yazma başladı, tray ikonu `media-record`-a keçdi, 15s səssizlikdən sonra avto-dayandı, child qalmadı;
real token ilə WS auth OK, credentials faylı dəyişmədi, kilid qalmadı; fon səs-küyü RMS ≤186 (hədd 400).
**Hələ istifadəçi tərəfindən yoxlanmalı:** real danışıqla avtomatik paste + clipboard bərpası.

**v2 test əmrləri:**
```bash
voice-dictate2 test 10
voice-dictate2 check-endpoint      # protokol + Claude Code kilid protokolu
NODE_PATH=~/.local/share/voice-dictate2/node_modules node ~/voice-dictate-v2/test/token.test.js
systemctl --user status voice-dictate2 voice-dictate2-hotkey
qdbus6 org.kde.StatusNotifierWatcher /StatusNotifierWatcher org.kde.StatusNotifierWatcher.RegisteredStatusNotifierItems
cat ~/.cache/voice-dictate2-paste.log ~/.cache/voice-dictate2-hotkey.log
```
