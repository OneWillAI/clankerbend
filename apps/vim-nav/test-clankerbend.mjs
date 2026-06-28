import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const APP_ID = "onewill.vim-nav";

const server = await startServer();
try {
  const state = await getJson(server, "/clankerbend/state");
  assert.equal(state.data.apps.some((app) => app.appId === APP_ID), true);
  assert.equal(state.data.transcript.anchors.length > 0, true);

  await assertAction(server, "latest-user", "vim.latestRole", { role: "user" }, "mock-3:user");
  await assertSelection(server, "mock-3:user");

  await assertAction(server, "search-branch", "vim.search", { query: "branch", direction: -1 }, "mock-1:user");
  await assertSelection(server, "mock-1:user");

  await assertAction(server, "next-user", "vim.jumpRole", { role: "user", direction: 1 }, "mock-3:user");
  await assertSelection(server, "mock-3:user");

  await assertAction(server, "jump-assistant", "vim.jump", { anchorId: "mock-4:assistant", block: "center" }, "mock-4:assistant");
  await assertSelection(server, "mock-4:assistant");

  console.log("clankerbend vim navigator fast e2e passed");
} finally {
  await server.stop();
}

async function assertAction(server, actionId, type, payload, expectedAnchorId) {
  const result = await postJson(server, `/clankerbend/apps/${encodeURIComponent(APP_ID)}/actions`, {
    action: {
      actionId,
      appId: APP_ID,
      type,
      payload,
      requestedAt: new Date().toISOString()
    }
  });
  assert.equal(result.data.ok, true);
  assert.equal(result.data.data.anchorId, expectedAnchorId);
}

async function assertSelection(server, expectedAnchorId) {
  const state = await getJson(server, "/clankerbend/state");
  assert.equal(state.data.selection.anchorId, expectedAnchorId);
}

async function startServer() {
  const child = spawn(process.execPath, ["server.mjs", "--mock"], {
    cwd: new URL(".", import.meta.url),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const launch = await waitForLaunch(child, () => stderr);
  return {
    child,
    baseUrl: launch.baseUrl,
    token: launch.token,
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit"),
        delay(1500).then(() => {
          child.kill("SIGKILL");
        })
      ]);
      await rm(new URL("./run", import.meta.url), { recursive: true, force: true });
    }
  };
}

async function waitForLaunch(proc, stderr) {
  const rl = readline.createInterface({ input: proc.stdout });
  const timeout = delay(5000).then(() => {
    throw new Error(`timed out waiting for host URL\n${stderr()}`);
  });
  const urlPromise = (async () => {
    let baseUrl = null;
    let token = "";
    for await (const line of rl) {
      const hostMatch = line.match(/^Host: (http:\/\/127\.0\.0\.1:\d+)/);
      if (hostMatch) baseUrl = hostMatch[1];
      const panelMatch = line.match(/^Panel: (http:\/\/127\.0\.0\.1:\d+\/\S+)/);
      if (panelMatch) token = new URL(panelMatch[1]).hash.match(/clankerbend_token=([^&]+)/)?.[1] || "";
      if (baseUrl && token) {
        rl.close();
        return { baseUrl, token: decodeURIComponent(token) };
      }
    }
    throw new Error(`server exited before host URL\n${stderr()}`);
  })();
  return Promise.race([urlPromise, timeout]);
}

async function getJson(server, pathname) {
  const res = await fetch(`${server.baseUrl}${pathname}`, { headers: authHeaders(server) });
  assert.equal(res.ok, true, `${pathname} returned ${res.status}`);
  const json = await res.json();
  assert.equal(json.ok, true, JSON.stringify(json));
  return json;
}

async function postJson(server, pathname, body) {
  const res = await fetch(`${server.baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(server) },
    body: JSON.stringify(body)
  });
  assert.equal(res.ok, true, `${pathname} returned ${res.status}`);
  const json = await res.json();
  assert.equal(json.ok, true, JSON.stringify(json));
  return json;
}

function authHeaders(server) {
  return server.token ? { authorization: `Bearer ${server.token}` } : {};
}
