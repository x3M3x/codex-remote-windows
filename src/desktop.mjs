export function isCodexDesktopMainProcess(process) {
  return (
    /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$/i.test(process.executablePath || "") &&
    !/\s--type(?:=|\s)/i.test(process.commandLine || "")
  );
}

export function needsRemoteControlSync(remoteControlEnabled, desktopOpen) {
  return remoteControlEnabled !== !desktopOpen;
}
