#!/bin/sh
# voice-dictate quraşdırma (Arch Linux / KDE Plasma Wayland / PipeWire)
set -e
REPO="$(cd "$(dirname "$0")" && pwd)"
SHARE="$HOME/.local/share/voice-dictate"
NODE="$(command -v node)"

echo "→ qovluqlar"
mkdir -p "$SHARE" "$HOME/.local/bin" "$HOME/.config/systemd/user" \
  "$HOME/.local/share/kwin/scripts" "$HOME/.local/share/dbus-1/services"

echo "→ voice-dictate.js"
cp "$REPO/src/voice-dictate.js" "$SHARE/"
chmod +x "$SHARE/voice-dictate.js"

echo "→ npm paketləri (ws, dbus-next)"
cd "$SHARE"
[ -f package.json ] || npm init -y >/dev/null
npm install --omit=dev ws dbus-next

echo "→ CLI symlink"
ln -sf "$SHARE/voice-dictate.js" "$HOME/.local/bin/voice-dictate"

echo "→ systemd user servisləri"
for f in "$REPO"/systemd/*.service; do
  sed "s|/home/patriot|$HOME|g; s|ExecStart=.*voice-dictate.js listen|ExecStart=$NODE $SHARE/voice-dictate.js listen|" "$f" > "$HOME/.config/systemd/user/$(basename "$f")"
done

echo "→ KWin script"
mkdir -p "$HOME/.local/share/kwin/scripts/voicedictate/contents/code"
cp "$REPO/kwin/voicedictate/metadata.json" "$REPO/kwin/voicedictate/metadata.desktop" \
   "$HOME/.local/share/kwin/scripts/voicedictate/"
cp "$REPO/kwin/voicedictate/contents/code/main.js" \
   "$HOME/.local/share/kwin/scripts/voicedictate/contents/code/"

echo "→ hotkey loader skripti"
cat > "$HOME/.local/bin/voice-dictate-hotkey-load.sh" <<EOF
#!/bin/sh
LOG="\$HOME/.cache/voice-dictate-hotkey.log"
: > "\$LOG"
i=0
while [ \$i -lt 90 ]; do
  if qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded voicedictate 2>>"\$LOG" | grep -q true; then
    echo "\$(date '+%T') yüklendi, start() (cəhd \$i)" >> "\$LOG"
    qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >>"\$LOG" 2>&1
    exit 0
  fi
  echo "\$(date '+%T') yüklənir... (cəhd \$i)" >> "\$LOG"
  qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript \
    "$HOME/.local/share/kwin/scripts/voicedictate/contents/code/main.js" voicedictate >>"\$LOG" 2>&1
  i=\$((i+1))
  sleep 2
done
exit 1
EOF
chmod +x "$HOME/.local/bin/voice-dictate-hotkey-load.sh"

echo "→ DBus aktivasiya"
sed "s|/home/patriot|$HOME|g; s|Exec=.*voice-dictate.js|Exec=$NODE $SHARE/voice-dictate.js|" \
  "$REPO/dbus/org.local.VoiceDictate.service" > "$HOME/.local/share/dbus-1/services/org.local.VoiceDictate.service"

echo "→ dil konfiqi (ilk dəfə)"
[ -f "$HOME/.config/voice-dictate.json" ] || echo '{"language":"tr"}' > "$HOME/.config/voice-dictate.json"

echo "→ systemd enable"
systemctl --user daemon-reload
systemctl --user enable --now voice-dictate
systemctl --user enable --now voice-dictate-hotkey

echo
echo "Bitti. Ctrl+Space ilə danış, yenidən bas — mətn kursora düşəcək."
echo "Test: voice-dictate test 10"
