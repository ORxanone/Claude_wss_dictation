#!/bin/sh
# KWin scriptini yükləyir. Vacib: loadScript() kifayət deyil, Scripting.start() da lazımdır.
LOG="$HOME/.cache/voice-dictate2-hotkey.log"
MAIN="$HOME/.local/share/kwin/scripts/voicedictate2/contents/code/main.js"
: > "$LOG"
i=0
while [ $i -lt 90 ]; do
  if qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded voicedictate2 2>>"$LOG" | grep -q true; then
    echo "$(date '+%T') yükləndi, start() (cəhd $i)" >> "$LOG"
    qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >>"$LOG" 2>&1
    exit 0
  fi
  echo "$(date '+%T') yüklənir... (cəhd $i)" >> "$LOG"
  qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript "$MAIN" voicedictate2 >>"$LOG" 2>&1
  i=$((i+1))
  sleep 2
done
exit 1
