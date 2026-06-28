export const STICKY_NOTES_APP_ID = "onewill.sticky-notes";

export function createStickyNotesApp(options = {}) {
  const notes = new Map();

  return {
    appId: STICKY_NOTES_APP_ID,
    name: "Sticky Notes",
    publicDir: options.publicDir,
    contributes: {
      panel: true,
      annotations: true,
      actions: true,
      appState: true,
      selectionActions: true,
      overlays: true,
      composerContext: true,
      composerDraft: true
    },
    permissions: {
      transcriptRead: true,
      transcriptAnnotate: true,
      transcriptNavigate: true,
      overlayWrite: true,
      composerWrite: true,
      appServerRead: false,
      appServerApprove: false,
      appServerRollback: false
    },
    panel: {
      title: "Sticky Notes",
      reloadPolicy: "preserve",
      preferredWidth: 380
    },

    getManifest(context) {
      return {
        clankerbendVersion: context.protocolVersion,
        appId: STICKY_NOTES_APP_ID,
        name: "Sticky Notes",
        entry: context.entry,
        contributes: this.contributes,
        permissions: this.permissions,
        panel: this.panel
      };
    },

    getState(context) {
      const noteList = [...notes.values()];
      return {
        appId: STICKY_NOTES_APP_ID,
        status: "ready",
        source: context.desktop.target?.type === "mock" ? "mock" : "host-api",
        connected: context.desktop.cdpStatus === "connected",
        entries: noteList.map((note) => noteEntry(note)),
        annotations: annotationsForNotes(noteList, context),
        selectionActions: [
          selectionAction("sticky.addToChat", "Add to chat", "plus-square"),
          selectionAction("sticky.note.open", "Add note", "sticky-note")
        ],
        updatedAt: context.state.generatedAt
      };
    },

    async handleAction(action, context) {
      if (action.type === "sticky.note.open") {
        const selection = selectionFromAction(action, context);
        return openNoteOverlay(action, context, selection);
      }

      if (action.type === "sticky.note.create") {
        const selection = selectionFromAction(action, context);
        const body = String(action.payload?.body || action.payload?.note || "").trim();
        if (!body) throw context.httpError(400, "bad_request", "note body is required");
        const note = persistNoteFile(normalizeNote({
          noteId: action.payload?.noteId,
          body,
          selection,
          status: "queued",
          requestedAt: action.requestedAt
        }), context);
        notes.set(note.noteId, note);
        context.closeOverlay(action.payload?.overlayId, { broadcast: false });
        attachNoteFile(notes, note.noteId, context);
        return applied(action, { note, file: note.file, attachment: note.attachment });
      }

      if (action.type === "sticky.note.update") {
        const noteId = requireNoteId(action, context);
        const current = requireNote(notes, noteId, context);
        const body = String(action.payload?.body || action.payload?.note || "").trim();
        if (!body) throw context.httpError(400, "bad_request", "note body is required");
        const note = persistNoteFile({ ...current, body, updatedAt: action.requestedAt || new Date().toISOString(), attachment: null }, context);
        notes.set(noteId, note);
        attachNoteFile(notes, note.noteId, context);
        return applied(action, { note, file: note.file, attachment: note.attachment });
      }

      if (action.type === "sticky.note.delete") {
        const noteId = requireNoteId(action, context);
        const current = requireNote(notes, noteId, context);
        notes.delete(noteId);
        context.removeComposerContext(contextItemId(current.noteId), { broadcast: false });
        return applied(action, { noteId, deleted: true });
      }

      if (action.type === "sticky.note.resolve") {
        const noteId = requireNoteId(action, context);
        const current = requireNote(notes, noteId, context);
        const note = { ...current, status: "resolved", updatedAt: action.requestedAt || new Date().toISOString() };
        notes.set(noteId, note);
        context.removeComposerContext(contextItemId(noteId), { broadcast: false });
        return applied(action, { note });
      }

      if (action.type === "sticky.addToChat") {
        const selection = selectionFromAction(action, context);
        const item = context.addComposerContext(selectionContextItem(action, selection), { broadcast: false }).item;
        return applied(action, { contextItem: item });
      }

      if (action.type === "sticky.compose.insertContext") {
        const text = composePrompt(context, action.payload?.userText || "");
        const result = await context.setComposerDraft({
          text,
          mode: action.payload?.mode || "replace",
          contextItemIds: context.state.composer.contextItems
            .filter((item) => item.appId === STICKY_NOTES_APP_ID)
            .map((item) => item.itemId)
        }, { broadcast: false });
        return applied(action, { draft: result.draft || context.state.composer.draft });
      }

      throw context.httpError(404, "not_found", `unknown action: ${action.type}`);
    }
  };
}

function selectionFromAction(action, context) {
  const selection = action.payload?.selection || context.selection;
  if (!selection?.anchorId) throw context.httpError(400, "bad_request", "selection.anchorId is required");
  const range = selection.range || {
    anchorId: selection.anchorId,
    text: selection.quote || context.findAnchor(selection.anchorId)?.textPreview || "",
    quote: selection.quote || context.findAnchor(selection.anchorId)?.textPreview || "",
    prefix: "",
    suffix: ""
  };
  return {
    selectionId: selection.selectionId || `sel_${action.actionId}`,
    anchorId: selection.anchorId,
    quote: selection.quote || range.quote || range.text || "",
    range: { ...range, anchorId: selection.anchorId },
    rect: selection.rect || null,
    selectedAt: selection.selectedAt || action.requestedAt || new Date().toISOString()
  };
}

function openNoteOverlay(action, context, selection) {
  const overlay = context.openOverlay({
    appId: STICKY_NOTES_APP_ID,
    kind: "form",
    title: "Add note",
    anchorId: selection.anchorId,
    range: selection.range,
    anchorRect: selection.rect,
    fields: [{
      fieldId: "body",
      kind: "textarea",
      label: "Add note",
      value: action.payload?.body || ""
    }],
    actions: [
      {
        label: "Cancel",
        type: "overlay.close"
      },
      {
        label: "Save",
        type: "sticky.note.create",
        payload: { selection }
      }
    ]
  }, { broadcast: false }).overlay;
  return applied(action, { overlay });
}

function normalizeNote(input) {
  const now = input.requestedAt || new Date().toISOString();
  const quote = input.selection.quote || input.selection.range?.text || "";
  return {
    noteId: input.noteId || `note_${hashId(`${input.selection.anchorId}:${quote}:${input.body}:${now}`)}`,
    appId: STICKY_NOTES_APP_ID,
    anchorId: input.selection.anchorId,
    quote,
    range: input.selection.range,
    rect: input.selection.rect || null,
    body: input.body,
    file: input.file || null,
    attachment: input.attachment || null,
    status: input.status || "queued",
    createdAt: now,
    updatedAt: now
  };
}

function persistNoteFile(note, context) {
  if (!context.writeRuntimeFile) return note;
  const file = context.writeRuntimeFile({
    fileId: `sticky-note:${note.noteId}`,
    directory: "notes",
    filename: noteFilename(note),
    mimeType: "text/markdown; charset=utf-8",
    content: noteMarkdown(note)
  });
  return { ...note, file, updatedAt: note.updatedAt || file.createdAt };
}

function attachNoteFile(notes, noteId, context) {
  const note = notes.get(noteId);
  if (!note?.file || !context.attachRuntimeFiles) return;
  const pending = { ok: null, status: "pending", requestedAt: new Date().toISOString() };
  notes.set(noteId, { ...note, attachment: pending });
  context.attachRuntimeFiles([note.file], { broadcast: false })
    .then((attachment) => {
      const current = notes.get(noteId);
      if (!current) return;
      notes.set(noteId, { ...current, attachment, updatedAt: new Date().toISOString() });
      context.requestStateBroadcast?.();
    })
    .catch((err) => {
      const current = notes.get(noteId);
      if (!current) return;
      notes.set(noteId, { ...current, attachment: { ok: false, error: err.message }, updatedAt: new Date().toISOString() });
      context.requestStateBroadcast?.();
    });
}

function noteMarkdown(note) {
  return [
    "# Note",
    "",
    "The user made a note on the transcript above.",
    "",
    "## Highlighted text",
    "",
    blockquote(note.quote),
    "",
    "## User notes",
    "",
    note.body,
    ""
  ].join("\n");
}

function blockquote(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function noteContextItem(note) {
  return {
    itemId: contextItemId(note.noteId),
    appId: STICKY_NOTES_APP_ID,
    label: labelFromQuote(note.quote),
    body: note.body,
    anchorId: note.anchorId,
    range: note.range,
    status: note.status === "resolved" ? "resolved" : "queued"
  };
}

function selectionContextItem(action, selection) {
  return {
    itemId: `selection_${hashId(`${selection.anchorId}:${selection.quote}:${action.actionId}`)}`,
    appId: STICKY_NOTES_APP_ID,
    label: labelFromQuote(selection.quote || selection.range?.text || selection.anchorId),
    body: selection.quote || selection.range?.text || "",
    anchorId: selection.anchorId,
    range: selection.range,
    status: "queued"
  };
}

function composePrompt(context, userText) {
  const items = context.state.composer.contextItems.filter((item) => item.appId === STICKY_NOTES_APP_ID);
  const sections = items.map((item, index) => {
    const quote = item.range?.quote || item.range?.text || item.label;
    return `Context ${index + 1}: ${item.label}\nSelected text: ${quote}\nNote: ${item.body || quote}`;
  });
  return [
    "Use these selected transcript notes as context:",
    "",
    ...sections.flatMap((section) => [section, ""]),
    "User request:",
    String(userText || "").trim()
  ].join("\n").trim();
}

function annotationsForNotes(notes, context) {
  const selectedAnchorId = context.selection?.anchorId;
  return notes
    .filter((note) => note.status !== "resolved")
    .map((note) => ({
      appId: STICKY_NOTES_APP_ID,
      anchorId: note.anchorId,
      placement: "leading-rail",
      priority: 70,
      markers: [{
        markerId: `sticky:${note.noteId}`,
        glyph: "N",
        label: note.body,
        tone: note.anchorId === selectedAnchorId ? "accent" : "warning",
        shape: "pill",
        entryId: `sticky:${note.noteId}`,
        action: {
          type: "sticky.note.open",
          payload: { noteId: note.noteId, selection: { anchorId: note.anchorId, quote: note.quote, range: note.range } }
        }
      }]
    }));
}

function noteEntry(note) {
  return {
    entryId: `sticky:${note.noteId}`,
    appId: STICKY_NOTES_APP_ID,
    anchorId: note.anchorId,
    title: labelFromQuote(note.quote),
    summary: note.body,
    category: "note",
    tone: note.status === "resolved" ? "muted" : "warning",
    status: note.status,
    detail: {
      quote: note.quote,
      file: note.file,
      attachment: note.attachment
    },
    occurredAt: note.updatedAt
  };
}

function selectionAction(type, label, icon) {
  return {
    actionId: type,
    appId: STICKY_NOTES_APP_ID,
    type,
    label,
    icon,
    appliesTo: "text-selection",
    enabled: true
  };
}

function applied(action, data) {
  return {
    actionId: action.actionId,
    appId: STICKY_NOTES_APP_ID,
    ok: true,
    status: "applied",
    data,
    completedAt: new Date().toISOString()
  };
}

function requireNoteId(action, context) {
  const noteId = action.payload?.noteId;
  if (!noteId) throw context.httpError(400, "bad_request", "noteId is required");
  return noteId;
}

function requireNote(notes, noteId, context) {
  const note = notes.get(noteId);
  if (!note) throw context.httpError(404, "not_found", "note not found");
  return note;
}

function contextItemId(noteId) {
  return `sticky:${noteId}`;
}

function labelFromQuote(quote) {
  const text = String(quote || "selected text").replace(/\s+/g, " ").trim();
  return text.length > 28 ? `${text.slice(0, 25)}...` : text;
}

function noteFilename(note) {
  const words = String(note.body || "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  const slug = words.join("-") || "untitled";
  const suffix = hashId(note.noteId).slice(0, 5);
  return `note_${slug}_${suffix}.md`;
}

function hashId(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
