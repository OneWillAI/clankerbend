const APP_ID = "onewill.sticky-notes";

const els = {
  subtitle: document.getElementById("subtitle"),
  notes: document.getElementById("notes"),
  userText: document.getElementById("user-text"),
  insertContext: document.getElementById("insert-context")
};

const token = readToken();
let currentState = null;

els.insertContext.addEventListener("click", () => runAction("sticky.compose.insertContext", {
  userText: els.userText.value,
  mode: "replace"
}));

bootstrap();

async function bootstrap() {
  const state = await getJson("/clankerbend/state");
  render(state);
  connectEvents();
}

function render(state) {
  currentState = state;
  const app = (state.apps || []).find((candidate) => candidate.appId === APP_ID);
  const entries = app?.entries || [];
  els.subtitle.textContent = `${entries.length} note${entries.length === 1 ? "" : "s"} queued`;
  els.notes.replaceChildren(...entries.map((entry) => {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const summary = document.createElement("div");
    summary.textContent = entry.summary;
    const meta = document.createElement("small");
    meta.textContent = entry.status;
    li.append(title, summary, meta);
    return li;
  }));
}

async function runAction(type, payload = {}) {
  const action = {
    actionId: `${type}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    appId: APP_ID,
    type,
    payload,
    requestedAt: new Date().toISOString()
  };
  const result = await postJson(`/clankerbend/apps/${encodeURIComponent(APP_ID)}/actions`, { action });
  const state = await getJson("/clankerbend/state");
  render(state);
  return result;
}

function readToken() {
  const params = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
  const value = params.get("clankerbend_token") || "";
  if (value) history.replaceState(null, "", location.pathname + location.search);
  return value;
}

function headers(extra = {}) {
  return {
    ...extra,
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
}

function connectEvents() {
  if (!token) {
    const events = new EventSource("/clankerbend/events");
    events.addEventListener("state", (event) => render(JSON.parse(event.data)));
    events.addEventListener("action", () => getJson("/clankerbend/state").then(render));
    return;
  }
  fetch("/clankerbend/events", { headers: headers() }).then(async (res) => {
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
        const event = chunk.split(/\n/).find((line) => line.startsWith("event: "))?.slice(7);
        const data = chunk.split(/\n/).filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (event === "state" && data) render(JSON.parse(data));
        if (event === "action") getJson("/clankerbend/state").then(render);
      }
    }
  });
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
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message || `request failed: ${res.status}`);
  return json.data;
}
