# codex-remote-windows

Run the [Codex](https://openai.com/codex/) app-server remote control as a managed Windows process: auto-restart on crash, auto-start at logon, and automatic handover with the Codex desktop app.

## Why

Codex remote control lets you reach your machine's Codex chats from mobile or another device. Normally it only runs while the desktop app is open. This package keeps a standalone app-server running so remote control works even when the desktop app is closed - and yields to the desktop app whenever it is open.

## Requirements

- Windows
- Node.js 22+
- Codex desktop app installed (provides `codex.exe`)

## Install

```powershell
npm install -g codex-remote-windows
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

Once started, remote control appears as this machine in the Codex mobile app / web, sharing the same chats and account as the desktop app.

## Desktop app handover

The Codex desktop app runs its own app-server that holds the backend remote-control session while it is open - only one session per account is allowed. codex-rc cooperates instead of fighting it:

- Desktop app open: the codex-rc watcher stays on standby; the desktop app serves remote control.
- Desktop app closed: within ~5 seconds the watcher starts the standalone app-server on your port, so remote control keeps working.
- If the standalone server crashes, the watcher restarts it (up to 50 rapid attempts, then gives up; the counter resets after 60s of stable uptime).

`codex-rc status` tells you which mode you are in.

## Auto-start at logon

`codex-rc install` registers a Windows scheduled task (`CodexRemoteControl`) that runs `codex-rc start` when you log on. No admin rights required. `codex-rc uninstall` removes it.

## Logs

`logs/codex-rc.log` inside the package directory contains the watcher lifecycle and app-server output. While the desktop app holds the session you may see `409 Remote app server already online` warnings from a previous server instance - harmless and expected.

## License

MIT
