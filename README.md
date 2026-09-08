# codex-remote-windows

Run the [Codex](https://openai.com/codex/) app-server remote control as a managed Windows process: auto-restart on crash, auto-start at logon, and automatic handover with the Codex desktop app.

## Why

Codex remote control lets you reach your machine's Codex chats from mobile or another device. Normally it only runs while the desktop app is open. This package keeps a standalone app-server running so remote control works even when the desktop app is closed - and yields to the desktop app whenever it is open.

## Requirements

- Windows
- Node.js 22+
- Codex CLI installed (provides `codex.exe`)

## Install

```powershell
npm install -g codex-remote-windows --foreground-scripts
```

## Usage

```powershell
codex-rc start      # start app-server with a crash-restart watcher
codex-rc stop       # stop the watcher and app-server
codex-rc restart    # stop, then start again
codex-rc status     # show remote control status
codex-rc install    # register a scheduled task so it starts at logon
codex-rc uninstall  # remove the scheduled task and stop everything
codex-rc --port 15000 start   # any command accepts --port (default 14567)
```

With the desktop app closed, remote control appears as this machine in Codex mobile / web.

## Connect the Codex CLI

Point the Codex CLI at the running server:

```powershell
codex --remote ws://127.0.0.1:14567 resume
```

Use the port you configured with `--port` if you changed the default. With the desktop app closed, the CLI and mobile app both attach to this same server. Codex still allows only one active writer per thread, so `resume <thread-id>` fails until the existing writer releases that task.

## Desktop app handover

The Codex desktop app runs its own app-server that holds the mobile remote-control backend session while it is open - only one session per account is allowed. codex-rc keeps a local server running at all times so CLI clients never lose connection, and only the mobile session defers to the desktop app:

- Desktop app open: Desktop and mobile share the desktop server. The local server still serves CLI clients, but those tasks are separate from Desktop/mobile tasks.
- Desktop app closed: the watcher retries every ~5 seconds until it enables mobile remote control on the local server, so CLI and mobile share its tasks.
- If the standalone server crashes, the watcher restarts it (up to 50 rapid attempts, then gives up; the counter resets after 60s of stable uptime).

`codex-rc status` tells you which mode you are in.

Codex currently permits one mobile Remote Control session per account. The desktop app does not expose its app-server as a TCP `--remote` endpoint, so the CLI cannot piggyback on it. A live task cannot be shared across Desktop, a separate local CLI server, and mobile while Desktop is open.

## Auto-start at logon

`codex-rc install` registers a Windows scheduled task (`CodexRemoteControl`) that runs `codex-rc start` when you log on. No admin rights required. `codex-rc uninstall` removes it.

## Logs

`logs/codex-rc.log` inside the package directory contains the watcher lifecycle and app-server output. While the desktop app holds the session you may see `409 Remote app server already online` warnings from a previous server instance - harmless and expected.

## License

MIT
