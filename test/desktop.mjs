import assert from "node:assert/strict";
import { isCodexDesktopMainProcess, needsRemoteControlSync } from "../src/desktop.mjs";

const path = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe";

assert.equal(isCodexDesktopMainProcess({ executablePath: path, commandLine: "\"" + path + "\"" }), true);
assert.equal(isCodexDesktopMainProcess({ executablePath: path, commandLine: "\"" + path + "\" --type=renderer" }), false);
assert.equal(isCodexDesktopMainProcess({ executablePath: "C:\\Apps\\ChatGPT.exe", commandLine: "ChatGPT.exe" }), false);

assert.equal(needsRemoteControlSync(null, true), true);
assert.equal(needsRemoteControlSync(false, true), false);
assert.equal(needsRemoteControlSync(false, false), true);
