registerShortcut("Voice Dictate Toggle", "Danışıq yazısını işə sal/durdur", "Ctrl+Space", () => {
    callDBus("org.local.VoiceDictate", "/org/local/VoiceDictate", "org.local.VoiceDictate", "Toggle");
});
registerShortcut("Voice Dictate Cancel", "Danışıq yazısını ləğv et", "", () => {
    callDBus("org.local.VoiceDictate", "/org/local/VoiceDictate", "org.local.VoiceDictate", "Cancel");
});
