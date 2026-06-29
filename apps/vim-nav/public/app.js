const APP_ID = "onewill.vim-nav";

const els = {
  subtitle: document.getElementById("subtitle"),
  openPanel: document.getElementById("open-panel"),
  commandInput: document.getElementById("command-input"),
  runCommand: document.getElementById("run-command"),
  commandStatus: document.getElementById("command-status"),
  currentIndex: document.getElementById("current-index"),
  currentTitle: document.getElementById("current-title"),
  currentPreview: document.getElementById("current-preview"),
  anchorCount: document.getElementById("anchor-count"),
  anchorList: document.getElementById("anchor-list")
};

let currentState = null;
let search = { query: "", index: -1 };
let lastRenderSignature = "";
const token = readToken();

els.openPanel.addEventListener("click", async () => {
  try {
    await postJson("/clankerbend/panel/open", {});
  } catch (err) {
    els.commandStatus.textContent = err.message;
  }
});
els.runCommand.addEventListener("click", () => runCommand(els.commandInput.value));
els.commandInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runCommand(els.commandInput.value);
  }
});
bootstrap();

async function bootstrap() {
  try {
    const state = await getJson("/clankerbend/state");
    render(state, true);
    connectEvents();
  } catch (err) {
    els.subtitle.textContent = "disconnected";
    els.commandStatus.textContent = err.message;
  }
}

function readToken() {
  const params = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
  const fragmentToken = params.get("clankerbend_token") || "";
  const bootstrapToken = window.__CLANKERBEND_TOKEN || "";
  const metaToken = document.querySelector("meta[name='clankerbend-token']")?.content || "";
  const inlineToken = readInlineBootstrapToken();
  const cachedToken = readCachedToken();
  const value = fragmentToken || bootstrapToken || metaToken || inlineToken || cachedToken;
  if (fragmentToken) history.replaceState(null, "", location.pathname + location.search);
  if (value) writeCachedToken(value);
  return value;
}

function readInlineBootstrapToken() {
  for (const script of document.scripts) {
    const match = script.textContent?.match(/window\.__CLANKERBEND_TOKEN=("[^"]*");?/);
    if (!match) continue;
    try {
      return JSON.parse(match[1]);
    } catch {
      return "";
    }
  }
  return "";
}

function readCachedToken() {
  try {
    return sessionStorage.getItem("clankerbend_token") || "";
  } catch {
    return "";
  }
}

function writeCachedToken(value) {
  try {
    sessionStorage.setItem("clankerbend_token", value);
  } catch {}
}

function headers(extra = {}) {
  return {
    ...extra,
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
}

async function connectEvents() {
  if (!token) {
    const events = new EventSource("/clankerbend/events");
    events.addEventListener("state", (event) => render(JSON.parse(event.data)));
    events.addEventListener("app-state", () => getJson("/clankerbend/state").then((state) => render(state)));
    events.addEventListener("action", () => getJson("/clankerbend/state").then((state) => render(state)));
    events.addEventListener("error", () => {
      els.subtitle.textContent = "event stream interrupted";
    });
    return;
  }

  const res = await fetch("/clankerbend/events", { headers: headers() });
  if (!res.ok || !res.body) throw new Error(`events failed: ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleSseChunk(chunk);
    }
  }
}

function handleSseChunk(chunk) {
  const lines = chunk.split(/\n/);
  const event = lines.find((line) => line.startsWith("event: "))?.slice(7) || "message";
  const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
  if (!data || event === "heartbeat") return;
  if (event === "state") render(JSON.parse(data));
  if (event === "app-state" || event === "action") getJson("/clankerbend/state").then((state) => render(state));
}

async function runCommand(raw) {
  const command = String(raw || "").trim();
  if (!command) return;
  const anchors = currentAnchors();
  const current = currentAnchor();
  let result = null;

  try {
    if (/^:\d+$/.test(command)) {
      result = await jumpToIndex(Number(command.slice(1)) - 1);
    } else if (/^\d+$/.test(command)) {
      result = await jumpToIndex(Number(command) - 1);
    } else if (command === "j") {
      result = await runAction("vim.jumpRelative", { delta: 1 });
    } else if (command === "k") {
      result = await runAction("vim.jumpRelative", { delta: -1 });
    } else if (command === "gg") {
      result = await runAction("vim.jumpIndex", { index: 0 });
    } else if (command === "G") {
      result = await runAction("vim.jumpIndex", { index: -1 });
    } else if (command === "{") {
      result = await runAction("vim.jumpRole", { role: "user", direction: -1 });
    } else if (command === "}") {
      result = await runAction("vim.jumpRole", { role: "user", direction: 1 });
    } else if (command.startsWith("/")) {
      search.query = command.slice(1).trim();
      search.index = -1;
      result = await runAction("vim.search", { query: search.query, direction: 1 });
    } else if (command === "n") {
      result = await searchAgain(1);
    } else if (command === "N") {
      result = await searchAgain(-1);
    } else if (command === ":latest assistant") {
      result = await runAction("vim.latestRole", { role: "assistant" });
    } else if (command === ":latest user") {
      result = await runAction("vim.latestRole", { role: "user" });
    } else {
      result = { ok: false, error: `unknown command: ${command}` };
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  els.commandStatus.textContent = result?.ok ? result.message || "ok" : result?.error || "failed";
  if (result?.ok) els.commandInput.value = "";
}

function currentAnchors() {
  return currentState?.transcript?.anchors || [];
}

function currentApp() {
  return (currentState?.apps || []).find((app) => app.appId === APP_ID) || null;
}

function currentAnchor() {
  const anchors = currentAnchors();
  const selected = currentState?.selection?.anchorId;
  return anchors.find((anchor) => anchor.anchorId === selected) ||
    anchors.find((anchor) => anchor.visible) ||
    anchors[0] ||
    null;
}

function currentIndex() {
  const anchors = currentAnchors();
  const current = currentAnchor();
  return Math.max(0, anchors.findIndex((anchor) => anchor.anchorId === current?.anchorId));
}

async function jumpToIndex(index) {
  const anchors = currentAnchors();
  if (!anchors.length) return { ok: false, error: "no anchors" };
  const clamped = Math.max(0, Math.min(anchors.length - 1, index));
  return jumpToAnchor(anchors[clamped].anchorId);
}

async function jumpToAnchor(anchorId) {
  return runAction("vim.jump", { anchorId, behavior: "smooth", block: "center" }, anchorId);
}

async function searchAgain(direction) {
  if (!search.query) return { ok: false, error: "empty search" };
  return runAction("vim.search", { query: search.query, direction });
}

async function runAction(type, payload = {}, anchorId) {
  const action = {
    actionId: `${type}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    appId: APP_ID,
    type,
    anchorId: anchorId || payload.anchorId,
    entryId: (anchorId || payload.anchorId) ? `nav:${anchorId || payload.anchorId}` : undefined,
    payload,
    requestedAt: new Date().toISOString()
  };
  const result = await postJson(`/clankerbend/apps/${encodeURIComponent(APP_ID)}/actions`, { action });
  if (result.ok) getJson("/clankerbend/state").then((state) => render(state));
  return result.ok ? { ok: true, message: result.status || "ok" } : { ok: false, error: result.error || "action failed" };
}

function render(state, force = false) {
  if (!state) return;
  currentState = state;
  const app = currentApp();
  const signature = JSON.stringify({
    sequence: state.sequence,
    anchors: (state.transcript?.anchors || []).map((anchor) => `${anchor.anchorId}:${anchor.visible ? 1 : 0}`),
    selection: state.selection?.anchorId,
    appServer: state.appServer?.status,
    appUpdatedAt: app?.updatedAt
  });
  if (!force && signature === lastRenderSignature) return;
  lastRenderSignature = signature;

  const anchors = currentAnchors();
  const current = currentAnchor();
  const index = anchors.findIndex((anchor) => anchor.anchorId === current?.anchorId);
  els.subtitle.textContent = `${state.desktop?.cdpStatus || "unknown"} · ${app?.status || "unknown"} · app-server ${state.appServer?.status || "unknown"}`;
  els.anchorCount.textContent = String(anchors.length);
  els.currentIndex.textContent = index >= 0 ? String(index + 1).padStart(2, "0") : "--";
  els.currentTitle.textContent = current ? `${current.inferredRole || current.kind} · ${current.visible ? "visible" : "offscreen"}` : "No transcript anchor";
  els.currentPreview.textContent = current?.textPreview || "Waiting for transcript anchors.";
  renderAnchors(anchors, current);
}

function renderAnchors(anchors, current) {
  els.anchorList.replaceChildren(...anchors.slice(0, 300).map((anchor) => {
    const item = document.createElement("li");
    item.className = anchor.anchorId === current?.anchorId ? "is-selected" : "";
    const button = document.createElement("button");
    button.type = "button";
    button.addEventListener("click", () => jumpToAnchor(anchor.anchorId));
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = anchor.indexed === false ? "?" : String(anchor.order).padStart(2, "0");
    const body = document.createElement("span");
    body.className = "anchor-body";
    const title = document.createElement("strong");
    title.textContent = anchor.inferredRole || anchor.kind;
    const preview = document.createElement("span");
    preview.textContent = anchor.textPreview || "No preview";
    body.append(title, preview);
    button.append(idx, body);
    item.append(button);
    return item;
  }));
}

function empty(text) {
  const span = document.createElement("span");
  span.className = "empty";
  span.textContent = text;
  return span;
}

async function getJson(url) {
  const res = await fetch(url, { headers: headers() });
  return unwrap(res);
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify(body)
  });
  return unwrap(res);
}

async function unwrap(res) {
  const envelope = await res.json();
  if (!envelope.ok) {
    throw new Error(envelope.error?.message || `request failed: ${res.status}`);
  }
  return envelope.data;
}
