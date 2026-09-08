import http from "node:http";

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForReady(port, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get("http://127.0.0.1:" + port + "/readyz", (res) => {
          res.resume();
          res.statusCode === 200 ? resolve() : reject(new Error("readyz " + res.statusCode));
        });
        req.on("error", reject);
        req.setTimeout(1000, () => req.destroy(new Error("timeout")));
      });
      return true;
    } catch {
      await wait(500);
    }
  }
  throw new Error("App-server did not become ready on port " + port);
}

export function connect(port) {
  const ws = new WebSocket("ws://127.0.0.1:" + port);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("Cannot connect to ws://127.0.0.1:" + port));
  });
}

export function createRpc(ws) {
  let nextId = 0;
  const pending = new Map();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };

  return (method, params = null) =>
    new Promise((resolve) => {
      const id = String(++nextId);
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
}

export async function enableRemoteControl(port) {
  await waitForReady(port);
  const ws = await connect(port);
  const rpc = createRpc(ws);

  await rpc("initialize", {
    clientInfo: { name: "codex-remote-control-win", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });

  await rpc("experimentalFeature/enablement/set", {
    enablement: { remote_control: true },
  });

  await rpc("remoteControl/enable");

  let latest = await rpc("remoteControl/status/read");
  for (let i = 0; i < 20 && latest.result?.status !== "connected"; i += 1) {
    await wait(1000);
    latest = await rpc("remoteControl/status/read");
  }

  ws.close();
  return latest.result || { status: "unknown" };
}

export async function readStatus(port) {
  await waitForReady(port, 5);
  const ws = await connect(port);
  const rpc = createRpc(ws);

  await rpc("initialize", {
    clientInfo: { name: "codex-remote-control-win", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });

  const result = await rpc("remoteControl/status/read");
  ws.close();
  return result.result || { status: "unknown" };
}

export async function disableRemoteControl(port) {
  await waitForReady(port, 5);
  const ws = await connect(port);
  const rpc = createRpc(ws);

  await rpc("initialize", {
    clientInfo: { name: "codex-remote-control-win", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });

  const result = await rpc("remoteControl/disable");
  ws.close();
  return result.result;
}
