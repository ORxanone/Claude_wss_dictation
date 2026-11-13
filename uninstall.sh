#!/bin/sh
# voice-dictate2-ni tam silir. v1-ə (voice-dictate) toxunmur.
systemctl --user disable --now voice-dictate2 voice-dictate2-hotkey 2>/dev/null
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript voicedictate2 >/dev/null 2>&1
rm -f "$HOME/.config/systemd/user/voice-dictate2.service" \
      "$HOME/.config/systemd/user/voice-dictate2-hotkey.service" \
      "$HOME/.local/bin/voice-dictate2" "$HOME/.local/bin/voice-dictate2-hotkey-load.sh" \
      "$HOME/.local/share/dbus-1/services/org.local.VoiceDictate2.service" \
      "$HOME/.cache/voice-dictate2.state.json"
rm -rf "$HOME/.local/share/voice-dictate2" "$HOME/.local/share/kwin/scripts/voicedictate2"
systemctl --user daemon-reload
echo "voice-dictate2 silindi (konfiq qaldı: ~/.config/voice-dictate2.json)"
