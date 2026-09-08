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
import { enableRemoteControl, readStatus } from "../src/rpc.mjs";

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
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  return execSync("powershell -NoProfile -EncodedCommand " + b64).toString();
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

// The Codex desktop app runs its own app-server WITHOUT --listen (stdio/pipes
// to the Electron app). It holds the backend remote-control session while open.
function getDesktopServerPids() {
  return findPids("codex.*app-server(?!.*--listen)");
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
const MAX_RESTARTS = 50;

function shutdown() {
  shuttingDown = true;
  log("Watcher stopping");
  if (child) killPid(child.pid);
  cleanupPidFiles();
  process.exit(0);
}

function desktopActive() {
  return getDesktopServerPids().length > 0;
}

function spawnServer() {
  const startedAt = Date.now();
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

  enableRemoteControl(PORT)
    .then((status) => log("Remote control status: " + JSON.stringify(status)))
    .catch((err) => log("Enable warning: " + err.message));

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
    if (desktopActive()) {
      log("Codex desktop app-server is active - going on standby");
      return;
    }
    log("Restarting in 3s (attempt " + restarts + "/" + MAX_RESTARTS + ")");
    setTimeout(spawnServer, 3000);
  });
}

// Supervisor loop: while the Codex desktop app is open, its own app-server
// holds the backend remote-control session (same account, same chats), so ours
// stands by. The moment it closes, we start ours so remote control continues.
function supervise() {
  if (shuttingDown) return;
  if (desktopActive()) {
    if (child) {
      log("Codex desktop app-server detected - handing over remote control and going on standby");
      killPid(child.pid);
    }
    return;
  }
  if (!child) {
    log("No desktop app-server - taking over on port " + PORT);
    spawnServer();
  }
}

function startWatch() {
  writeFileSync(WATCH_PID_FILE, String(process.pid));
  log("Watcher running (pid " + process.pid + ") on port " + PORT + ", desktop handover enabled");
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
    console.log("Running on port " + PORT);
    console.log(JSON.stringify(status, null, 2));
  } catch (err) {
    if (getDesktopServerPids().length) {
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
  const script =
    "$action = New-ScheduledTaskAction -Execute '" + q + process.execPath + q + "' -Argument '" + q + cliPath + q + " start --port " + PORT + "' -WorkingDirectory '" + ROOT + "'; " +
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User (whoami); " +
    "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew; " +
    "Register-ScheduledTask -TaskName '" + TASK_NAME + "' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null";
  ps(script);
  console.log("Scheduled task " + TASK_NAME + " registered (starts at logon on port " + PORT + ")");
}

function doUninstall() {
  doStop();
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
