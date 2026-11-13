// voice-dictate2 KWin script. Qısayol install.sh-də VD_SHORTCUT ilə dəyişdirilir;
// sonradan System Settings → Shortcuts → "Voice Dictate v2 Toggle".
registerShortcut("Voice Dictate v2 Toggle", "Danışıq yazısını işə sal/durdur (v2)", "__SHORTCUT__", () => {
    callDBus("org.local.VoiceDictate2", "/org/local/VoiceDictate2", "org.local.VoiceDictate2", "Toggle");
});
registerShortcut("Voice Dictate v2 Cancel", "Danışıq yazısını ləğv et (v2)", "", () => {
    callDBus("org.local.VoiceDictate2", "/org/local/VoiceDictate2", "org.local.VoiceDictate2", "Cancel");
});
