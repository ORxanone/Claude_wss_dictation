#!/bin/sh
LOG="$HOME/.cache/voice-dictate-hotkey.log"
: > "$LOG"
i=0
while [ $i -lt 90 ]; do
  if qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded voicedictate 2>>"$LOG" | grep -q true; then
    echo "$(date '+%T') yüklendi, start() (cəhd $i)" >> "$LOG"
    qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >>"$LOG" 2>&1
    exit 0
  fi
  echo "$(date '+%T') yüklənir... (cəhd $i)" >> "$LOG"
  qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript /home/patriot/.local/share/kwin/scripts/voicedictate/contents/code/main.js voicedictate >>"$LOG" 2>&1
  i=$((i+1))
  sleep 2
done
exit 1
