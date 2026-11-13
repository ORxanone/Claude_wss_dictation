# voice-dictate2 — istifadə qaydası

## Nədir
İstənilən proqramda **Ctrl+Space** → danış → mətn kursora düşür. İki backend:
- **anthropic** — Claude Code tokeni (Pro/Max abunəlik). Default.
- **web** — claude.ai cookie (**pulsuz hesab da işləyir**, abunəlik lazım deyil).

## İlk quraşdırma (yeni kompüterdə də eyni)
```bash
git clone https://github.com/ORxanone/Claude_wss_dictation.git ~/voice-dictate-v2
cd ~/voice-dictate-v2 && git checkout web-backend   # web backend bu branchdədir
./install.sh                                         # Ctrl+Space, tray, servis qurur
```
Sonra backend seç (aşağı). `./install.sh` v1-ə (varsa) toxunmur.

## Gündəlik əmrlər
```bash
voice-dictate2 toggle        # başlat / dayandır (Ctrl+Space ilə eyni)
voice-dictate2 status        # yazır / boşta
voice-dictate2 test 10       # terminalda 10s test
voice-dictate2 backend       # cari backend
systemctl --user restart voice-dictate2   # servisi yenilə
```

## Backend seçimi / keçid

### Pulsuz claude.ai (web) — abunəliksiz
1. Brauzerdə claude.ai-a gir. F12 → Application → Cookies → `https://claude.ai`:
   - `sessionKey` = `sk-ant-sid02-...` dəyəri
   - `lastActiveOrg` = organizationUuid (UUID)
2. Yaz (əmr tarixçəsinə düşmür, fayl 0600):
   ```bash
   voice-dictate2 web-login
   ```
3. Keçid:
   ```bash
   voice-dictate2 backend web && systemctl --user restart voice-dictate2
   ```
4. Yoxla: `voice-dictate2 web-check`

> sessionKey müddəti bitəndə (401/403 xətası) sadəcə yenidən `voice-dictate2 web-login`. Backend dəyişmir.
> Brauzerdə "Log out" etsən cookie köhnəlir.

### Claude Code tokeni (anthropic) — Pro/Max
```bash
voice-dictate2 backend anthropic && systemctl --user restart voice-dictate2
```
Token yoxdursa: Claude Code-u aç, `/login` et (claude.ai hesabı ilə).

## Köçərkən / yedəklə saxlamalı fayllar (repoda YOXDUR)
| Fayl | Qeyd |
|---|---|
| `~/.config/voice-dictate2.web.json` | **sessionKey** — yalnız bunu itirmə (və ya brauzerdən yenisini al). 0600. |
| `~/.config/voice-dictate2.json` | ayarlar (backend, dil). İstəyə bağlı; yoxdursa default yaranır. |
| `~/.claude/.credentials.json` | Claude Code tokeni — **köçürmə**, yeni kompüterdə `/login` et. |

Qalan hər şey (kod, install.sh) GitHub-dadır.

## Konfiq (`~/.config/voice-dictate2.json`)
```json
{
  "backend": "anthropic",     // və ya "web"
  "language": "tr",           // az dəstəklənmir; tr azərbaycancanı düzgün yazır
  "silenceStopMs": 15000,     // bu qədər səssizlikdə avto-dayan (0 = söndür)
  "maxRecordMs": 120000,
  "silenceRms": 400,
  "tray": true,
  "restoreClipboard": true    // paste sonrası əvvəlki clipboard qayıdır; transcript Super+V-də qalır
}
```

## Problemlər
- Mətn düşmür, yalnız clipboard: `~/.cache/voice-dictate2-paste.log`-a bax (ydotool).
- Qısayol işləmir: `systemctl --user status voice-dictate2-hotkey`, `cat ~/.cache/voice-dictate2-hotkey.log`.
- web "sessionKey köhnəlib": `voice-dictate2 web-login`.
- anthropic server xətası: `voice-dictate2 check-endpoint` (Claude Code protokolu dəyişibmi).

## Silmək
```bash
~/voice-dictate-v2/uninstall.sh   # yalnız v2-ni silir, konfiq qalır
```
