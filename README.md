# voice-dictate (Claude_wss_dictation)

**İstənilən proqramda `Ctrl+Space` → danış → mətn birbaşa kursorun yerinə düşür.**

Claude Code-un (claude.ai subscription) daxili diktə (speech-to-text) sistemini reverse-engineering
yolu ilə kəşf edib, onu KDE Plasma Wayland-da sistem qısayolu kimi istənilən proqramdan
istifadə olunacaq şəkildə yenidən qurmuşuq. Abunəlik (Pro/Max) kifayətdir — ayrıca API açarı yoxdur.

## Necə işləyir

```
Ctrl+Space (fiziki)
  → KWin script registerShortcut (kompozitor daxili, global qısayol)
  → callDBus org.local.VoiceDictate / Toggle
  → systemd voice-dictate.service (Node daemon, dbus-next)
  → detached child: pw-record (16k/s16/mono/raw) → WebSocket-ə realtime stream
  → CloseStream → final transcript
  → wl-copy + ydotool Ctrl+V paste (kursora, Unicode-safe) + notify-send
```

## Protokol (Claude Code 2.1.322 bundle-dan çıxarıldı)

- `wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`
  `?encoding=linear16&sample_rate=16000&channels=1&endpointing_ms=300&utterance_end_ms=1000&language=<xx>&use_conversation_engine=true`
- Headers: `Authorization: Bearer <claude.ai OAuth accessToken>`, `User-Agent: claude-cli/<ver> (external, cli)`, `x-app: cli`
- Göndərilən: `{"type":"KeepAlive"}` (qoşulanda + hər 5s), raw PCM s16le/16k/mono binary frame-lər, `{"type":"CloseStream"}`
- Gələn: `TranscriptInterim` / `TranscriptText` / `TranscriptEndpoint` / `TranscriptError`
- Token: `~/.claude/.credentials.json` → `claudeAiOauth`; yeniləmə `POST https://platform.claude.com/v1/oauth/token` (atomik yazma ilə)

## Tələblər

- Arch Linux / KDE Plasma 6 (Wayland), PipeWire
- Node ≥ 22 (`ws`, `dbus-next` npm paketləri install.sh quraşdırır)
- `pipewire`, `wl-clipboard`, `ydotool` (`ydotoold` işlək), `qt6-tools` (qdbus6)

## Quraşdırma

```bash
./install.sh
```

Script edir: `voice-dictate.js` → `~/.local/share/voice-dictate/`, npm paketləri, systemd user
servisləri (daemon + hotkey loader), KWin script, DBus aktivasiya, CLI symlink.
Sonra yenidən login et (və ya `systemctl --user start voice-dictate voice-dictate-hotkey`).

## İstifadə

```bash
voice-dictate test 15        # terminalda test: 15 san danış → transcript + clipboard
voice-dictate toggle         # manual başlat/dayandır
voice-dictate cancel | stop | status
```

Dil konfiqi: `~/.config/voice-dictate.json` → `{"language":"tr"}`
(qeyd: `az` server tərəfindən dəstəklənmir, `tr` azərbaycanca əla yazır).

## Əhəmiyyətli dərslər (bug şərhi)

1. **ydotool `type` qeyri-ASCII hərfləri atır** (ə, ş, ö, ü, ı, ç — US keymap limiti).
   Həll: `wl-copy` + `ydotool key Ctrl+V` paste. Paste-dən əvvəl 200ms gözlə ki, wl-copy
   clipboard-u ələ alsın.
2. **Daemon WAYLAND_DISPLAY olmadan qalxa bilər** (systemd user env Plazma env-indən əvvəl).
   `wl-copy` səssizcə işləmir. Həll: `XDG_RUNTIME_DIR`-də `wayland-*` socket-i avtomatik tap.
3. **ydotool client socket-i:** default `$XDG_RUNTIME_DIR/.ydotool_socket`; `XDG_RUNTIME_DIR`
   yoxdursa `/tmp/.ydotool_socket`-a baxır və uğursuz olur.
4. KWin script üçün `loadScript()` kifayət deyil — `Scripting.start()` da lazımdır.
5. Token `expiresAt` millisaniyə rəqəmidir, ISO string deyil.

Tam texniki yaddaş: [PROJECT_MEMORY.md](PROJECT_MEMORY.md)

## Bəyanat

Bu, Anthropic-in qeyri-rəsmi istifadəsidir (Claude Code ilə eyni endpoint). Şəxsi istifadə üçün
nəzərdə tutulub; ToS riski istifadəçiyə aiddir.

## License

MIT
