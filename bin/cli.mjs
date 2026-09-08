#!/usr/bin/env node
// codex-remote-windows: manage Codex app-server remote control on Windows.
// Commands: start | stop | restart | status | install | uninstall
import { spawn, execSync } from "node:child_process";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { disableRemoteControl, enableRemoteControl, readStatus } from "../src/rpc.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const LOG_DIR = join(ROOT, "logs");
const LOG_FILE = join(LOG_DIR, "codex-rc.log");
const TASK_NAME = "CodexRemoteControl";

const args = process.argv.slice(2);
let PORT = 14567;
const rest = [];
for (let i = 0; i < args.length; i += 1) {
  if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
    PORT = parseInt(args[i + 1], 10);
    i += 1;
  } else {
    rest.push(args[i]);
  }
}
const WATCH = rest.includes("--watch");
const CMD = rest.filter((a) => a !== "--watch")[0] || "status";

const PID_FILE = join(ROOT, ".codex-rc-" + PORT + ".pid");
const WATCH_PID_FILE = join(ROOT, ".codex-rc-watch-" + PORT + ".pid");

function ps(script) {
  const b64 = Buffer.from("$ProgressPreference = 'SilentlyContinue'; " + script, "utf16le").toString("base64");
  return execSync("powershell -NoProfile -OutputFormat Text -EncodedCommand " + b64, { windowsHide: true }).toString();
}

function log(msg) {
  const line = new Date().toISOString() + " " + msg;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function findCodexExe() {
  const base = join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin");
  if (!existsSync(base)) throw new Error("Codex not found at " + base);
  const out = ps(
    "Get-ChildItem -LiteralPath '" + base + "' -Recurse -Filter codex.exe -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName"
  ).trim();
  if (!out) throw new Error("codex.exe not found under " + base);
  return out;
}

function findPids(regex) {
  try {
    const out = ps(
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '" + regex + "' } | Select-Object -ExpandProperty ProcessId"
    ).trim();
    return out ? out.split(/\r?\n/).map(Number).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// Our own spawned servers always carry --listen on this port.
function getAppServerPids() {
  return findPids("app-server.*127\\.0\\.0\\.1:" + PORT + "(\\D|$)");
}

function getWatcherPids() {
  return findPids("cli\\.mjs.*--watch.*--port " + PORT + "(\\D|$)");
}

// The Codex desktop app's Electron main process is ChatGPT.exe under
// WindowsApps/OpenAI.Codex_*. Detecting the Electron app itself (not its
// app-server child) means a force-killed desktop leaving an orphaned backend
// no longer blocks take-over.
function getDesktopPids() {
  return findPids('WindowsApps[\\/]OpenAI\.Codex_[^"]*ChatGPT\.exe');
}

function killPid(pid) {
  try {
    process.kill(pid);
  } catch {}
}

function cleanupPidFiles() {
  try { unlinkSync(PID_FILE); } catch {}
  try { unlinkSync(WATCH_PID_FILE); } catch {}
}

function doStart() {
  const existing = [...getWatcherPids(), ...getAppServerPids()];
  if (existing.length) {
    console.log("Stopping existing processes: " + existing.join(", "));
    for (const pid of existing) killPid(pid);
    pause(1500);
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--watch", "--port", String(PORT)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  console.log("Watcher started (pid " + child.pid + "), app-server will listen on ws://127.0.0.1:" + PORT);
}

let child = null;
let shuttingDown = false;
let restarts = 0;
let rcEnabled = false;
let rcPending = false;
const MAX_RESTARTS = 50;

function shutdown() {
  shuttingDown = true;
  log("Watcher stopping");
  if (child) killPid(child.pid);
  cleanupPidFiles();
  process.exit(0);
}

function desktopActive() {
  return getDesktopPids().length > 0;
}

function spawnServer() {
  const startedAt = Date.now();
  rcEnabled = false; // fresh app-server always starts with remote control disabled
  const codexExe = findCodexExe();
  log("Starting app-server on ws://127.0.0.1:" + PORT);
  child = spawn(codexExe, ["app-server", "--listen", "ws://127.0.0.1:" + PORT, "--analytics-default-enabled"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  writeFileSync(PID_FILE, String(child.pid));
  mkdirSync(LOG_DIR, { recursive: true });
  const out = createWriteStream(LOG_FILE, { flags: "a" });
  child.stdout.pipe(out);
  child.stderr.pipe(out);

  syncRemoteControl();

  child.on("exit", (code, signal) => {
    log("App-server exited (code " + code + ", signal " + signal + ")");
    child = null;
    if (shuttingDown) return;
    if (Date.now() - startedAt > 60000) restarts = 0;
    if (restarts >= MAX_RESTARTS) {
      log("Gave up after " + MAX_RESTARTS + " restarts");
      process.exit(1);
    }
    restarts += 1;
    log("Restarting in 3s (attempt " + restarts + "/" + MAX_RESTARTS + ")");
    setTimeout(spawnServer, 3000);
  });
}

// The local server always stays up so CLI clients (codex --remote
// ws://127.0.0.1:PORT) never lose connection. Only the mobile remote-control
// backend session defers to the desktop app: while it is open, its app-server
// holds that session, and we enable ours the moment it closes.
function supervise() {
  if (shuttingDown) return;
  if (!child) {
    spawnServer();
    return;
  }
  syncRemoteControl();
}

async function syncRemoteControl() {
  const desktop = desktopActive();
  if (!child || rcPending || rcEnabled === !desktop) return;
  rcPending = true;
  try {
    if (desktop) {
      await disableRemoteControl(PORT);
      rcEnabled = false;
      log("Desktop app open - mobile remote control handed over, local server still serving port " + PORT);
    } else {
      await enableRemoteControl(PORT);
      rcEnabled = true;
      log("Desktop app closed - mobile remote control enabled on port " + PORT);
    }
  } catch (err) {
    log("Remote control sync warning: " + err.message);
  } finally {
    rcPending = false;
  }
}

function startWatch() {
  writeFileSync(WATCH_PID_FILE, String(process.pid));
  process.on("uncaughtException", (err) => {
    log("Watcher error (continuing): " + (err && err.stack || err));
  });
  process.on("unhandledRejection", (err) => {
    log("Watcher rejection (continuing): " + (err && err.stack || err));
  });
  log("Watcher running (pid " + process.pid + ") on port " + PORT + " (CLI always served; mobile remote control defers to desktop app)");
  supervise();
  setInterval(supervise, 5000);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function doStop() {
  const watchers = getWatcherPids();
  const servers = getAppServerPids();
  const all = [...watchers, ...servers];
  if (!all.length) {
    console.log("Not running on port " + PORT);
  } else {
    for (const pid of all) killPid(pid);
    console.log("Stopped watcher [" + watchers.join(", ") + "] and app-server [" + servers.join(", ") + "]");
  }
  cleanupPidFiles();
}

async function doStatus() {
  try {
    const status = await readStatus(PORT);
    const heldByDesktop = getDesktopPids().length > 0;
    console.log("Running on port " + PORT + (heldByDesktop ? " (local CLI served; mobile remote control held by the desktop app)" : ""));
    console.log(JSON.stringify(status, null, 2));
  } catch (err) {
    if (getDesktopPids().length) {
      const watching = getWatcherPids().length > 0;
      console.log("Codex desktop app-server is holding remote control" + (watching ? " - codex-rc watcher is on standby and takes over when it closes" : " - run 'codex-rc start' to supervise and take over when it closes"));
    } else {
      console.log("Not running on port " + PORT + " (" + err.message + ")");
      process.exitCode = 1;
    }
  }
}

function doRestart() {
  doStop();
  pause(2000);
  doStart();
}

function doInstall() {
  const cliPath = fileURLToPath(import.meta.url);
  const q = '"';
  const dq = '""';
  const vbsPath = join(ROOT, "run-hidden.vbs");
  const inner = dq + process.execPath + dq + " " + dq + cliPath + dq + " start --port " + PORT;
  writeFileSync(vbsPath, "CreateObject(" + q + "WScript.Shell" + q + ").Run " + q + inner + q + ", 0, False");
  const script =
    "$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '//B " + q + vbsPath + q + "' -WorkingDirectory '" + ROOT + "'; " +
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User (whoami); " +
    "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew; " +
    "Register-ScheduledTask -TaskName '" + TASK_NAME + "' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null";
  ps(script);
  console.log("Scheduled task " + TASK_NAME + " registered (starts at logon on port " + PORT + ")");
}

function doUninstall() {
  doStop();
  try { unlinkSync(join(ROOT, "run-hidden.vbs")); } catch {}
  try {
    ps("Unregister-ScheduledTask -TaskName '" + TASK_NAME + "' -Confirm:$false");
    console.log("Scheduled task " + TASK_NAME + " removed");
  } catch {
    console.log("No scheduled task " + TASK_NAME + " found");
  }
}

const HELP = [
  "Usage: codex-rc [command] [--port N]",
  "",
  "Commands:",
  "  start      Start app-server with a crash-restart watcher",
  "  stop       Stop the watcher and app-server",
  "  restart    Stop, then start again",
  "  status     Show remote control status",
  "  install    Register a scheduled task so it starts at logon",
  "  uninstall  Remove the scheduled task and stop everything",
  "",
  "Options:",
  "  --port N   App-server port (default 14567)",
  "",
  "While the Codex desktop app is open, its own app-server keeps remote",
  "control; the codex-rc watcher stands by and takes over when it closes.",
].join("\n");

try {
  if (WATCH) startWatch();
  else if (CMD === "start") doStart();
  else if (CMD === "stop") doStop();
  else if (CMD === "restart") doRestart();
  else if (CMD === "status") await doStatus();
  else if (CMD === "install") doInstall();
  else if (CMD === "uninstall") doUninstall();
  else {
    console.log(HELP);
    if (CMD !== "help") process.exitCode = 1;
  }
} catch (err) {
  console.error("Error: " + err.message);
  process.exitCode = 1;
}
