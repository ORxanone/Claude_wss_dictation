#!/bin/sh
# voice-dictate2 quraşdırma (Arch Linux / KDE Plasma 6 Wayland / PipeWire)
# v1 (voice-dictate) ilə yan-yana işləyir — bütün adlar fərqlidir.
#   VD_SHORTCUT="Meta+H" ./install.sh     # qısayolu dəyiş (default Ctrl+Alt+Space)
set -e
REPO="$(cd "$(dirname "$0")" && pwd)"
SHARE="$HOME/.local/share/voice-dictate2"
BIN="$HOME/.local/bin"
UNITS="$HOME/.config/systemd/user"
KWIN="$HOME/.local/share/kwin/scripts/voicedictate2"
NODE="$(command -v node)"
SHORTCUT="${VD_SHORTCUT:-Ctrl+Alt+Space}"

for t in node npm pw-record wl-copy ydotool qdbus6 notify-send; do
  command -v "$t" >/dev/null || { echo "XƏTA: '$t' tapılmadı"; exit 1; }
done

echo "→ proqram: $SHARE"
mkdir -p "$SHARE" "$BIN" "$UNITS" "$KWIN/contents/code" "$HOME/.local/share/dbus-1/services"
cp "$REPO/src/voice-dictate.js" "$SHARE/"
chmod +x "$SHARE/voice-dictate.js"

echo "→ npm paketləri (ws, dbus-next)"
cd "$SHARE"
[ -f package.json ] || npm init -y >/dev/null
npm install --silent --omit=dev ws dbus-next
cd "$REPO"

echo "→ CLI: $BIN/voice-dictate2"
ln -sf "$SHARE/voice-dictate.js" "$BIN/voice-dictate2"
cp "$REPO/systemd/voice-dictate2-hotkey-load.sh" "$BIN/"
chmod +x "$BIN/voice-dictate2-hotkey-load.sh"

subst() { sed "s|__NODE__|$NODE|g; s|__SHARE__|$SHARE|g; s|__BIN__|$BIN|g; s|__SHORTCUT__|$SHORTCUT|g" "$1"; }

echo "→ systemd user servisləri"
for f in "$REPO"/systemd/*.service; do subst "$f" > "$UNITS/$(basename "$f")"; done

echo "→ KWin script (qısayol: $SHORTCUT)"
cp "$REPO/kwin/voicedictate2/metadata.json" "$REPO/kwin/voicedictate2/metadata.desktop" "$KWIN/"
subst "$REPO/kwin/voicedictate2/contents/code/main.js" > "$KWIN/contents/code/main.js"

echo "→ DBus aktivasiya"
subst "$REPO/dbus/org.local.VoiceDictate2.service" > "$HOME/.local/share/dbus-1/services/org.local.VoiceDictate2.service"

echo "→ konfiq (yoxdursa)"
[ -f "$HOME/.config/voice-dictate2.json" ] || cat > "$HOME/.config/voice-dictate2.json" <<'EOF'
{
  "language": "tr",
  "silenceStopMs": 15000,
  "maxRecordMs": 120000,
  "silenceRms": 400,
  "tray": true,
  "clientVersion": ""
}
EOF

echo "→ systemd enable + start"
systemctl --user daemon-reload
systemctl --user enable voice-dictate2 voice-dictate2-hotkey
systemctl --user restart voice-dictate2
systemctl --user restart voice-dictate2-hotkey || true

echo
echo "Bitti. $SHORTCUT → danış → $SHORTCUT. Tray-də mikrofon ikonu görünməlidir."
echo "Test: voice-dictate2 test 10    Protokol yoxlaması: voice-dictate2 check-endpoint"
