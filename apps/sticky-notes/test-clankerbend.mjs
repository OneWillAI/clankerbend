import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexDesktopCdpAdapter } from "../../host/src/codex-desktop-cdp-adapter.js";
import { ClankerBendHost, createMockTranscriptAdapter } from "../../host/src/index.js";
import { createStickyNotesApp, STICKY_NOTES_APP_ID } from "./src/sticky-notes-app.js";

await runStickyNotesHostApiCheck();

console.log("clankerbend sticky notes fast e2e passed");

async function runStickyNotesHostApiCheck() {
  const runDir = await mkdtemp(join(tmpdir(), "clankerbend-sticky-test-"));
  const host = new ClankerBendHost({
    hostId: "onewill.clankerbend.sticky-test",
    hostName: "ClankerBend Sticky Test Host",
    runDir,
    transcriptAdapter: createMockTranscriptAdapter({ defaultAppId: STICKY_NOTES_APP_ID })
  });
  host.registerApp(createStickyNotesApp({
    publicDir: new URL("./public", import.meta.url).pathname
  }));
  await host.start();
  try {
    const server = { baseUrl: host.state.host.url, token: host.token };
    const manifest = await getJson(server, "/clankerbend/manifest");
    assert.equal(manifest.data.apps.some((app) => app.appId === STICKY_NOTES_APP_ID), true);
    assert.equal(manifest.data.capabilities.transcript.rangeSelect, true);
    assert.equal(manifest.data.capabilities.overlay.anchored, true);
    assert.equal(manifest.data.capabilities.composer.contextItems, true);

    const selection = {
      selectionId: "sticky-selection",
      source: "transcript",
      appId: STICKY_NOTES_APP_ID,
      anchorId: "mock-2:assistant",
      quote: "two changed files",
      range: {
        anchorId: "mock-2:assistant",
        text: "two changed files",
        quote: "two changed files",
        prefix: "I inspected the diff and found ",
        suffix: ".",
        startOffset: 31,
        endOffset: 48
      },
      selectedAt: new Date().toISOString()
    };
    const selected = await postJson(server, "/clankerbend/selection", { selection });
    assert.equal(selected.data.stale, false);
    assert.equal(selected.data.selection.range.text, "two changed files");

    const state = await getJson(server, "/clankerbend/state");
    assert.equal(state.data.selectionActions.some((action) => action.type === "sticky.note.open"), true);
    assert.deepEqual(state.data.composer.contextItems, []);

    const overlayAction = await appAction(server, "sticky-note-open", "sticky.note.open", {});
    assert.equal(overlayAction.data.ok, true);
    assert.equal(overlayAction.data.data.overlay.kind, "form");
    assert.equal(overlayAction.data.data.overlay.range.text, "two changed files");
    assert.deepEqual(overlayAction.data.data.overlay.actions.map((action) => action.label), ["Cancel", "Save"]);
    assert.deepEqual(overlayAction.data.data.overlay.actions.map((action) => action.type), ["overlay.close", "sticky.note.create"]);

    const noteAction = await appAction(server, "sticky-note-create", "sticky.note.create", {
      body: "where are these files?",
      selection
    });
    assert.equal(noteAction.data.ok, true);
    assert.equal(noteAction.data.data.note.body, "where are these files?");
    assert.equal(noteAction.data.data.note.file.relativePath.startsWith("apps/onewill.sticky-notes/notes/"), true);
    assert.equal(noteAction.data.data.file.path, noteAction.data.data.note.file.path);
    const noteFile = await readFile(noteAction.data.data.file.path, "utf8");
    assert.equal(noteFile, [
      "# Note",
      "",
      "The user made a note on the transcript above.",
      "",
      "## Highlighted text",
      "",
      "> two changed files",
      "",
      "## User notes",
      "",
      "where are these files?",
      ""
    ].join("\n"));
    assert.doesNotMatch(noteFile, /Note ID:/);
    assert.doesNotMatch(noteFile, /## Range/);
    const noteId = noteAction.data.data.note.noteId;

    const withNote = await waitForAttachment(server, noteAction.data.data.file.path);
    assert.equal(withNote.data.overlay, null);
    assert.equal(withNote.data.composer.contextItems.length, 0);
    assert.equal(withNote.data.composer.attachments.length, 1);
    assert.equal(withNote.data.composer.attachments[0].path, noteAction.data.data.file.path);
    assert.equal(withNote.data.apps[0].entries.length, 1);
    assert.equal(withNote.data.apps[0].entries[0].detail.file.path, noteAction.data.data.file.path);
    assert.equal(withNote.data.apps[0].entries[0].detail.attachment.ok, true);
    assert.equal(withNote.data.apps[0].annotations.length, 1);

    const updatedNote = await appAction(server, "sticky-note-update", "sticky.note.update", {
      noteId,
      body: "which files changed?"
    });
    assert.equal(updatedNote.data.data.note.body, "which files changed?");
    assert.match(await readFile(updatedNote.data.data.file.path, "utf8"), /which files changed\?/);

    const resolvedNote = await appAction(server, "sticky-note-resolve", "sticky.note.resolve", { noteId });
    assert.equal(resolvedNote.data.data.note.status, "resolved");
    const afterResolve = await getJson(server, "/clankerbend/state");
    assert.equal(afterResolve.data.composer.contextItems.some((item) => item.itemId === `sticky:${noteId}`), false);

    const recreatedNote = await appAction(server, "sticky-note-recreate", "sticky.note.create", {
      noteId: "note-to-delete",
      body: "delete me",
      selection
    });
    assert.equal(recreatedNote.data.data.note.noteId, "note-to-delete");
    const deletedNote = await appAction(server, "sticky-note-delete", "sticky.note.delete", { noteId: "note-to-delete" });
    assert.equal(deletedNote.data.data.deleted, true);

    const addToChat = await appAction(server, "sticky-add-to-chat", "sticky.addToChat", { selection });
    assert.equal(addToChat.data.ok, true);
    assert.equal(addToChat.data.data.contextItem.body, "two changed files");

    const draft = await appAction(server, "sticky-insert-context", "sticky.compose.insertContext", {
      userText: "please answer these",
      mode: "replace"
    });
    assert.equal(draft.data.ok, true);
    assert.match(draft.data.data.draft.text, /Use these selected transcript notes as context/);
    assert.match(draft.data.data.draft.text, /two changed files/);
    assert.match(draft.data.data.draft.text, /please answer these/);

    const highlight = await postJson(server, "/clankerbend/transcript/highlight-range", {
      range: selection.range,
      durationMs: 10
    });
    assert.equal(highlight.data.ok, true);
    assert.equal(highlight.data.range.text, "two changed files");

    const invalidRange = await postJson(server, "/clankerbend/transcript/highlight-range", {
      range: { text: "missing anchor" }
    }, { expectStatus: 400, expectOk: false });
    assert.equal(invalidRange.error.code, "bad_request");

    const adapter = createCodexDesktopCdpAdapter({ rendererBridges: [{ appId: STICKY_NOTES_APP_ID, injectedScriptPath: "unused" }] });
    adapter.host = host;
    await adapter.processRendererHostEvents([{
      kind: "overlayClose"
    }]);
    assert.equal((await getJson(server, "/clankerbend/state")).data.overlay, null);

    await adapter.processRendererHostEvents([{
      kind: "composerContextRemove",
      itemId: addToChat.data.data.contextItem.itemId
    }]);
    const afterRemove = await getJson(server, "/clankerbend/state");
    assert.equal(afterRemove.data.composer.contextItems.some((item) => item.itemId === addToChat.data.data.contextItem.itemId), false);

    await adapter.processRendererHostEvents([{
      kind: "appAction",
      eventId: "renderer-add-note",
      appId: STICKY_NOTES_APP_ID,
      type: "sticky.addToChat",
      payload: { selection },
      requestedAt: new Date().toISOString()
    }]);
    const afterRendererAction = await getJson(server, "/clankerbend/state");
    assert.equal(afterRendererAction.data.composer.contextItems.some((item) => item.body === "two changed files"), true);
  } finally {
    await host.stop();
    await rm(runDir, { recursive: true, force: true });
  }
}

async function appAction(server, actionId, type, payload) {
  return postJson(server, `/clankerbend/apps/${encodeURIComponent(STICKY_NOTES_APP_ID)}/actions`, {
    action: {
      actionId,
      appId: STICKY_NOTES_APP_ID,
      type,
      payload,
      requestedAt: new Date().toISOString()
    }
  });
}

async function waitForAttachment(server, filePath) {
  const deadline = Date.now() + 3000;
  let last = null;
  while (Date.now() < deadline) {
    last = await getJson(server, "/clankerbend/state");
    const attached = last.data.composer.attachments.some((item) => item.path === filePath);
    const entry = last.data.apps[0].entries.find((candidate) => candidate.detail?.file?.path === filePath);
    if (attached && entry?.detail?.attachment?.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`attachment did not complete: ${JSON.stringify(last?.data?.composer || null)}`);
}

async function getJson(server, pathname, options = {}) {
  const res = await fetch(`${server.baseUrl}${pathname}`, { headers: authHeaders(server) });
  if (options.expectStatus !== undefined) assert.equal(res.status, options.expectStatus);
  const json = await res.json();
  if (options.expectOk !== false) assert.equal(json.ok, true, JSON.stringify(json));
  return json;
}

async function postJson(server, pathname, body, options = {}) {
  const res = await fetch(`${server.baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(server) },
    body: JSON.stringify(body)
  });
  if (options.expectStatus !== undefined) assert.equal(res.status, options.expectStatus);
  const json = await res.json();
  if (options.expectOk !== false) assert.equal(json.ok, true, JSON.stringify(json));
  return json;
}

function authHeaders(server) {
  return server.token ? { authorization: `Bearer ${server.token}` } : {};
}
