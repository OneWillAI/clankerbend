import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));

const dom = createDomHarness();
const source = await readFile(join(ROOT, "host/src/codex-desktop-renderer-bridge.js"), "utf8");
const install = new Function(
  "window",
  "document",
  "location",
  "localStorage",
  "MutationObserver",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "requestAnimationFrame",
  "getComputedStyle",
  "InputEvent",
  "Event",
  "setTimeout",
  "clearTimeout",
  `${source}
return window.__clankerbendRuntime.getBridge("onewill.vim-nav");`
);

const bridge = install(
  dom.window,
  dom.document,
  dom.location,
  dom.localStorage,
  dom.MutationObserver,
  dom.Element,
  dom.HTMLElement,
  dom.HTMLInputElement,
  dom.HTMLTextAreaElement,
  dom.requestAnimationFrame,
  dom.window.getComputedStyle,
  dom.InputEvent,
  dom.Event,
  setTimeout,
  clearTimeout
);

assert.equal(bridge?.name, "vim-nav");

const transcriptAnchor = dom.document.createElement("div");
transcriptAnchor.setAttribute("data-content-search-unit-key", "mock-2:assistant");
transcriptAnchor.textContent = "pre-seed investor ownership pre-A x 2% percentage";
dom.document.body.appendChild(transcriptAnchor);

const nativeToolbar = dom.document.createElement("div");
nativeToolbar._rect = { left: 200, top: 96, right: 620, bottom: 138, width: 420, height: 42 };
const nativeAddToChat = dom.document.createElement("button");
nativeAddToChat.textContent = "Add to chat";
const nativeSideChat = dom.document.createElement("button");
nativeSideChat.textContent = "Ask in side chat";
nativeToolbar.append(nativeAddToChat, nativeSideChat);
dom.document.body.appendChild(nativeToolbar);

bridge.applyHostState({
  selectionActions: [{
    actionId: "sticky.note.open",
    appId: "onewill.sticky-notes",
    type: "sticky.note.open",
    label: "Add note",
    appliesTo: "text-selection",
    enabled: true
  }],
  composer: { contextItems: [] },
  overlay: null
});

dom.window.__testSelection = {
  rangeCount: 1,
  isCollapsed: false,
  toString: () => "percentage",
  getRangeAt: () => ({
    commonAncestorContainer: transcriptAnchor,
    getBoundingClientRect: () => ({ left: 240, top: 112, right: 320, bottom: 132, width: 80, height: 20 }),
    startContainer: transcriptAnchor
  })
};

assert.equal(bridge.__testUpdateTextSelectionFromDom(), true);
const nativeNoteButton = nativeToolbar.querySelector("[data-clankerbend-native-selection-action]");
assert.ok(nativeNoteButton);
assert.equal(nativeNoteButton.textContent, "📝 Add note");
assert.notEqual(dom.document.getElementById("clankerbend-selection-menu")?.classList.contains("is-visible"), true);
nativeNoteButton.click();
const nativeEvents = bridge.drainHostEvents();
assert.equal(nativeEvents.some((event) => event.kind === "appAction" && event.type === "sticky.note.open"), true);

const accountMenu = dom.document.createElement("div");
const logoutButton = dom.document.createElement("button");
logoutButton.textContent = "Log out";
accountMenu.appendChild(logoutButton);
dom.document.body.appendChild(accountMenu);

bridge.applyHostState({
  selectionActions: [],
  overlay: null,
  composer: { contextItems: [] },
  codexAccounts: {
    available: true,
    activeAccountId: "primary",
    clankerbendDefaultAccountId: "primary",
    maxAccounts: 20,
    switching: false,
    accounts: [{
      id: "primary",
      kind: "primary",
      label: "Primary",
      codexHome: "/Users/test/.codex",
      auth: { authJson: true }
    }]
  }
});
const accountSwitcher = dom.document.getElementById("clankerbend-account-switcher");
assert.ok(accountSwitcher);
assert.equal(accountSwitcher.querySelector(".clankerbend-account-title").textContent, "ClankerID");
assert.match(accountSwitcher.querySelector(".clankerbend-account-main").title, /CODEX_HOME: \/Users\/test\/\.codex/);
const addAccountButton = Array.from(accountSwitcher.querySelectorAll("button")).find((button) => button.textContent === "Add account");
assert.ok(addAccountButton);
addAccountButton.click();
const accountInput = accountSwitcher.querySelector("[data-clankerbend-account-label]");
assert.ok(accountInput);
accountInput.value = "Work";
accountInput.dispatchEvent(new dom.Event("input"));
bridge.applyHostState({
  selectionActions: [],
  overlay: null,
  composer: { contextItems: [] },
  codexAccounts: {
    available: true,
    activeAccountId: "primary",
    clankerbendDefaultAccountId: "primary",
    maxAccounts: 20,
    switching: false,
    accounts: [{
      id: "primary",
      kind: "primary",
      label: "Primary",
      codexHome: "/Users/test/.codex",
      auth: { authJson: true }
    }]
  }
});
assert.equal(accountSwitcher.querySelector("[data-clankerbend-account-label]"), accountInput);
assert.equal(accountInput.value, "Work");
const createAccountButton = Array.from(accountSwitcher.querySelectorAll("button")).find((button) => button.textContent === "Create");
assert.ok(createAccountButton);
createAccountButton.click();
const accountEvents = bridge.drainHostEvents();
assert.equal(accountEvents.some((event) => event.kind === "codexAccountCreateAndSwitch" && event.label === "Work"), true);

bridge.applyHostState({
  selectionActions: [],
  overlay: null,
  composer: { contextItems: [] },
  codexAccounts: {
    available: true,
    activeAccountId: "primary",
    clankerbendDefaultAccountId: "primary",
    maxAccounts: 20,
    switching: false,
    accounts: [{
      id: "primary",
      kind: "primary",
      label: "Primary",
      codexHome: "/Users/test/.codex",
      auth: { authJson: true }
    }, {
      id: "work",
      kind: "managed",
      label: "Work",
      codexHome: "/tmp/clankerbend/accounts/work/codex-home",
      auth: { authJson: true }
    }]
  }
});
const launchDefaultButton = Array.from(accountSwitcher.querySelectorAll("button")).find((button) => button.title.startsWith("Launch by default"));
assert.ok(launchDefaultButton);
assert.match(Array.from(accountSwitcher.querySelectorAll(".clankerbend-account-main")).find((button) => button.innerText.includes("Work")).title, /CODEX_HOME: \/tmp\/clankerbend\/accounts\/work\/codex-home/);
const manageAccountButton = Array.from(accountSwitcher.querySelectorAll("button")).find((button) => button.textContent === "Manage");
assert.ok(manageAccountButton);
manageAccountButton.click();
assert.ok(accountSwitcher.querySelector(".clankerbend-account-manage"));
assert.equal(accountSwitcher.querySelector(".clankerbend-account-manage-head strong").textContent, "Manage profiles");
assert.match(accountSwitcher.querySelector(".clankerbend-account-manage-row").title, /CODEX_HOME: \/tmp\/clankerbend\/accounts\/work\/codex-home/);
const adoptButton = Array.from(accountSwitcher.querySelectorAll("button")).find((button) => button.textContent === "Make primary");
assert.ok(adoptButton);
adoptButton.click();
const confirmAdoptButton = Array.from(accountSwitcher.querySelectorAll("button")).find((button) => button.textContent === "Replace ~/.codex");
assert.ok(confirmAdoptButton);
confirmAdoptButton.click();
const adoptEvents = bridge.drainHostEvents();
assert.equal(adoptEvents.some((event) => event.kind === "codexAccountAdoptAsPrimary" && event.accountId === "work"), true);

bridge.applyHostState({
  selectionActions: [],
  overlay: null,
  composer: { contextItems: [] },
  codexAccounts: {
    available: true,
    activeAccountId: "primary",
    clankerbendDefaultAccountId: "primary",
    maxAccounts: 20,
    switching: false,
    accounts: [{
      id: "primary",
      kind: "primary",
      label: "Primary",
      codexHome: "/Users/test/.codex",
      auth: { authJson: true }
    }, {
      id: "work",
      kind: "managed",
      label: "Work",
      codexHome: "/tmp/clankerbend/accounts/work/codex-home",
      auth: { authJson: true }
    }]
  }
});
const removeButton = Array.from(accountSwitcher.querySelectorAll("button")).find((button) => button.textContent === "Archive");
assert.ok(removeButton);
removeButton.click();
const confirmRemoveButton = Array.from(accountSwitcher.querySelectorAll("button")).find((button) => button.textContent === "Archive profile");
assert.ok(confirmRemoveButton);
confirmRemoveButton.click();
const removeEvents = bridge.drainHostEvents();
assert.equal(removeEvents.some((event) => event.kind === "codexAccountDelete" && event.accountId === "work"), true);

accountMenu.remove();
const nestedAccountMenu = dom.document.createElement("div");
const nestedLogoutWrap = dom.document.createElement("div");
nestedLogoutWrap._rect = { left: 120, top: 120, right: 220, bottom: 180, width: 100, height: 60 };
const nestedLogoutButton = dom.document.createElement("button");
nestedLogoutButton.textContent = "Log out";
nestedLogoutWrap.appendChild(nestedLogoutButton);
nestedAccountMenu.appendChild(nestedLogoutWrap);
dom.document.body.appendChild(nestedAccountMenu);
bridge.applyHostState({
  selectionActions: [],
  overlay: null,
  composer: { contextItems: [] },
  codexAccounts: {
    available: true,
    activeAccountId: "primary",
    clankerbendDefaultAccountId: "primary",
    maxAccounts: 20,
    switching: false,
    accounts: [{
      id: "primary",
      kind: "primary",
      label: "Primary",
      codexHome: "/Users/test/.codex",
      auth: { authJson: true }
    }]
  }
});
assert.equal(nestedAccountMenu.firstElementChild?.id, "clankerbend-account-switcher");
assert.equal(nestedAccountMenu.children[1], nestedLogoutWrap);

bridge.setTranscriptOrder(["stale-thread:0:user"], { source: "app-server" });
const staleOrderSnapshot = bridge.snapshot();
assert.equal(staleOrderSnapshot.anchors.length, 1);
assert.equal(staleOrderSnapshot.transcriptOrderSource, "mounted-dom-order");
assert.equal(staleOrderSnapshot.debug.lastOrderFallback.reason, "stale-app-server-order");
assert.equal(transcriptAnchor.querySelector(".codex-vim-nav-annotation")?.textContent, "1");

const helpButton = dom.document.querySelector("#codex-vim-nav-mode-badge .codex-vim-nav-help-toggle");
assert.ok(helpButton);
helpButton.dispatchEvent(new dom.Event("mousedown"));
assert.ok(dom.document.querySelector("#codex-vim-nav-mode-badge .codex-vim-nav-help-menu"));
helpButton.click();
assert.ok(dom.document.querySelector("#codex-vim-nav-mode-badge .codex-vim-nav-help-menu"));
dom.document.querySelector("#codex-vim-nav-mode-badge .codex-vim-nav-help-toggle").click();
assert.equal(dom.document.querySelector("#codex-vim-nav-mode-badge .codex-vim-nav-help-menu"), null);

const composerForm = dom.document.createElement("form");
composerForm._rect = { left: 44, top: 604, right: 856, bottom: 692, width: 812, height: 88 };
const composerInput = dom.document.createElement("textarea");
composerInput._rect = { left: 58, top: 638, right: 842, bottom: 682, width: 784, height: 44 };
composerForm.appendChild(composerInput);
const sendButton = dom.document.createElement("button");
sendButton._rect = { left: 812, top: 648, right: 844, bottom: 680, width: 32, height: 32 };
sendButton.setAttribute("aria-label", "Send");
composerForm.appendChild(sendButton);
dom.document.body.appendChild(composerForm);

const overlayState = {
  selectionActions: [],
  composer: {
    contextItems: []
  },
  overlay: {
    overlayId: "sticky-overlay-1",
    appId: "onewill.sticky-notes",
    kind: "form",
    title: "Add note",
    anchorId: "mock-2:assistant",
    fields: [{
      fieldId: "body",
      kind: "textarea",
      label: "Add note"
    }],
    actions: [
      {
        type: "overlay.close",
        label: "Cancel"
      },
      {
        type: "sticky.note.create",
        label: "Save",
        payload: {
          selection: {
            selectionId: "sticky-selection",
            anchorId: "mock-2:assistant",
            quote: "findTransitGeometryForPoint"
          }
        }
      }
    ]
  }
};

bridge.applyHostState(overlayState);
await delay(0);

const overlayEl = dom.document.getElementById("clankerbend-anchored-overlay");
const textarea = overlayEl.querySelector("[data-clankerbend-field-id]");
assert.ok(textarea instanceof dom.HTMLTextAreaElement);
assert.equal(textarea.placeholder, "Add note");
assert.equal(dom.document.activeElement, textarea);
assert.equal(textarea.lastFocusOptions?.preventScroll, true);
assert.equal(overlayEl.querySelector("strong"), null);
assert.ok(Number.parseFloat(overlayEl.style.top) + overlayEl.getBoundingClientRect().height <= 592);

textarea.value = "where is it defined?";
textarea.focus();

for (let i = 0; i < 5; i += 1) {
  bridge.applyHostState(overlayState);
  await delay(0);
}

const textareaAfterRefresh = overlayEl.querySelector("[data-clankerbend-field-id]");
assert.equal(textareaAfterRefresh, textarea);
assert.equal(textareaAfterRefresh.value, "where is it defined?");
assert.equal(dom.document.activeElement, textarea);

const buttons = overlayEl.querySelectorAll("button");
assert.equal(buttons.length, 2);
assert.equal(buttons[0]?.textContent, "Cancel");
assert.equal(buttons.at(-1)?.textContent, "Save");
buttons[0].click();

const cancelEvents = bridge.drainHostEvents();
assert.equal(cancelEvents.length, 1);
assert.equal(cancelEvents[0].kind, "overlayClose");
assert.equal(cancelEvents[0].overlayId, "sticky-overlay-1");

buttons.at(-1).click();

const events = bridge.drainHostEvents();
assert.equal(events.length, 1);
assert.equal(events[0].kind, "appAction");
assert.equal(events[0].appId, "onewill.sticky-notes");
assert.equal(events[0].type, "sticky.note.create");
assert.equal(events[0].payload.body, "where is it defined?");
assert.equal(events[0].payload.overlayId, "sticky-overlay-1");

bridge.applyHostState({
  selectionActions: [],
  overlay: null,
  composer: {
    contextItems: [{
      itemId: "sticky:note_1",
      appId: "onewill.sticky-notes",
      label: "pre-seed investor ownership pre-A x 2%",
      body: "define percentage?",
      anchorId: "mock-2:assistant",
      range: {
        anchorId: "mock-2:assistant",
        text: "pre-seed investor ownership pre-A x 2%",
        quote: "pre-seed investor ownership pre-A x 2%"
      }
    }]
  }
});

const chipsEl = dom.document.getElementById("clankerbend-composer-chips");
const chip = chipsEl.querySelector(".clankerbend-context-chip");
assert.ok(chip);
assert.equal(chip.querySelector("span").textContent, "pre-seed investor ownership pre-A x 2%");
assert.equal(chipsEl.parentElement, composerForm);
assert.equal(chipsEl.style.bottom, "auto");
assert.equal(chipsEl.style.left, "8px");
assert.equal(chipsEl.style.top, "8px");
assert.equal(chipsEl.style.maxWidth, "796px");
assert.equal(composerInput.value, "");

composerInput.value = "thoughts";
sendButton.click();
assert.match(composerInput.value, /^\[\[CLANKERBEND_CONTEXT:/);
assert.match(composerInput.value, /thoughts$/);

const submittedBubble = dom.document.createElement("div");
submittedBubble.textContent = composerInput.value;
dom.document.body.appendChild(submittedBubble);
await delay(80);
assert.equal(submittedBubble.querySelector(".clankerbend-submitted-context-row .clankerbend-context-chip").textContent, "pre-seed investor ownership pre-A x 2%");
assert.equal(submittedBubble.children.at(-1)?.textContent, "thoughts");

console.log("renderer sticky overlay e2e check passed");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDomHarness() {
  class FakeClassList {
    constructor(el) {
      this.el = el;
      this.values = new Set();
    }

    add(...names) {
      for (const name of names) this.values.add(name);
      this.sync();
    }

    remove(...names) {
      for (const name of names) this.values.delete(name);
      this.sync();
    }

    contains(name) {
      return this.values.has(name);
    }

    toggle(name, force) {
      const shouldAdd = force === undefined ? !this.values.has(name) : Boolean(force);
      if (shouldAdd) this.values.add(name);
      else this.values.delete(name);
      this.sync();
      return shouldAdd;
    }

    setFromString(value) {
      this.values = new Set(String(value || "").split(/\s+/).filter(Boolean));
      this.sync();
    }

    sync() {
      this.el._className = [...this.values].join(" ");
    }
  }

  class FakeElement {
    constructor(tagName, ownerDocument) {
      this.tagName = String(tagName || "div").toUpperCase();
      this.nodeName = this.tagName;
      this.ownerDocument = ownerDocument;
      this.children = [];
      this.parentElement = null;
      this.style = createStyleDeclaration();
      this.dataset = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.classList = new FakeClassList(this);
      this._className = "";
      this.id = "";
      this.textContent = "";
      this.value = "";
      this.name = "";
      this.placeholder = "";
      this.type = "";
      this.title = "";
      this.scrollTop = 0;
      this.scrollHeight = 800;
      this.clientHeight = 600;
    }

    get className() {
      return this._className;
    }

    get innerText() {
      return [this.textContent, ...this.children.map((child) => child.innerText || child.textContent || "")]
        .filter(Boolean)
        .join(" ");
    }

    get isConnected() {
      for (let node = this; node; node = node.parentElement) {
        if (node === this.ownerDocument.documentElement) return true;
      }
      return false;
    }

    get firstElementChild() {
      return this.children[0] || null;
    }

    get nextElementSibling() {
      if (!this.parentElement) return null;
      const index = this.parentElement.children.indexOf(this);
      return index >= 0 ? this.parentElement.children[index + 1] || null : null;
    }

    set innerText(value) {
      this.textContent = String(value || "");
    }

    set className(value) {
      this.classList.setFromString(value);
    }

    appendChild(child) {
      if (child.parentElement) child.parentElement.removeChild(child);
      child.parentElement = this;
      this.children.push(child);
      return child;
    }

    insertBefore(child, reference) {
      if (!reference || !this.children.includes(reference)) return this.appendChild(child);
      if (child.parentElement) child.parentElement.removeChild(child);
      child.parentElement = this;
      this.children.splice(this.children.indexOf(reference), 0, child);
      return child;
    }

    append(...children) {
      for (const child of children) this.appendChild(normalizeChild(child, this.ownerDocument));
    }

    replaceChildren(...children) {
      for (const child of this.children) child.parentElement = null;
      this.children = [];
      this.append(...children);
    }

    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) {
        this.children.splice(index, 1);
        child.parentElement = null;
      }
      return child;
    }

    remove() {
      this.parentElement?.removeChild(this);
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === "id") this.id = String(value);
      if (name === "class") this.className = String(value);
      if (name.startsWith("data-")) this.dataset[dataKey(name)] = String(value);
    }

    getAttribute(name) {
      if (name === "id") return this.id || null;
      if (name === "class") return this.className || null;
      if (name.startsWith("data-")) return this.dataset[dataKey(name)] || null;
      return this.attributes.get(name) || null;
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
    }

    dispatchEvent(event) {
      if (!event.target) event.target = this;
      for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
      if (event.bubbles !== false) {
        if (this.parentElement) this.parentElement.dispatchEvent(event);
        else this.ownerDocument.dispatchEvent(event);
      }
      return !event.defaultPrevented;
    }

    click() {
      this.dispatchEvent(new FakeEvent("click"));
    }

    focus(options) {
      this.lastFocusOptions = options;
      this.ownerDocument.activeElement = this;
    }

    blur() {
      if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
    }

    contains(node) {
      if (node === this) return true;
      return this.children.some((child) => child.contains?.(node));
    }

    matches(selector) {
      return selector.split(",").some((part) => matchesSimpleSelector(this, part.trim()));
    }

    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (node.matches?.(selector)) return node;
      }
      return null;
    }

    querySelectorAll(selector) {
      const output = [];
      walk(this, (child) => {
        if (child !== this && child.matches(selector)) output.push(child);
      });
      return output;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    getBoundingClientRect() {
      if (this._rect) return this._rect;
      const top = Number.parseFloat(this.style.top || "");
      const left = Number.parseFloat(this.style.left || "");
      if (this.id === "clankerbend-anchored-overlay") {
        return {
          left: Number.isFinite(left) ? left : 120,
          top: Number.isFinite(top) ? top : 120,
          right: (Number.isFinite(left) ? left : 120) + 340,
          bottom: (Number.isFinite(top) ? top : 120) + 188,
          width: 340,
          height: 188
        };
      }
      if (this.id === "clankerbend-composer-chips") {
        return {
          left: Number.isFinite(left) ? left : 44,
          top: Number.isFinite(top) ? top : 604,
          right: (Number.isFinite(left) ? left : 44) + 320,
          bottom: (Number.isFinite(top) ? top : 604) + 28,
          width: 320,
          height: 28
        };
      }
      return {
        left: 120,
        top: 120,
        right: 440,
        bottom: 180,
        width: 320,
        height: 60
      };
    }

    insertAdjacentElement(_position, element) {
      return this.appendChild(element);
    }
  }

  class FakeInputElement extends FakeElement {}
  class FakeTextAreaElement extends FakeElement {}

  class FakeDocument {
    constructor() {
      this.title = "Codex";
      this.listeners = new Map();
      this.documentElement = new FakeElement("html", this);
      this.body = new FakeElement("body", this);
      this.documentElement.appendChild(this.body);
      this.scrollingElement = this.documentElement;
      this.activeElement = this.body;
    }

    createElement(tagName) {
      if (tagName === "input") return new FakeInputElement(tagName, this);
      if (tagName === "textarea") return new FakeTextAreaElement(tagName, this);
      return new FakeElement(tagName, this);
    }

    getElementById(id) {
      return this.querySelector(`#${id}`);
    }

    querySelectorAll(selector) {
      return this.documentElement.querySelectorAll(selector);
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
    }

    dispatchEvent(event) {
      for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
      return !event.defaultPrevented;
    }
  }

  class FakeEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = options.bubbles !== false;
      this.inputType = options.inputType;
      this.data = options.data;
      this.defaultPrevented = false;
      this.target = null;
    }

    preventDefault() {
      this.defaultPrevented = true;
    }

    stopPropagation() {}
    stopImmediatePropagation() {}
  }

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }

    observe() {}
    disconnect() {}
  }

  const document = new FakeDocument();
  const window = {
    innerWidth: 900,
    innerHeight: 700,
    scrollY: 0,
    document,
    CSS: {
      escape: (value) => String(value).replace(/"/g, '\\"')
    },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({
      overflow: "visible",
      overflowY: "visible",
      position: "static"
    }),
    getSelection() {
      return this.__testSelection || {
        rangeCount: 0,
        isCollapsed: true,
        toString: () => ""
      };
    },
    scrollTo(_x, y) {
      this.scrollY = y;
    }
  };
  return {
    window,
    document,
    location: { href: "https://codex.local/thread" },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    MutationObserver: FakeMutationObserver,
    Event: FakeEvent,
    InputEvent: FakeEvent,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInputElement,
    HTMLTextAreaElement: FakeTextAreaElement,
    requestAnimationFrame: (callback) => setTimeout(callback, 0)
  };
}

function normalizeChild(child, document) {
  if (typeof child === "string") {
    const text = document.createElement("span");
    text.textContent = child;
    return text;
  }
  return child;
}

function createStyleDeclaration() {
  return {
    setProperty(name, value) {
      this[name] = String(value);
    }
  };
}

function walk(root, visitor) {
  for (const child of root.children || []) {
    visitor(child);
    walk(child, visitor);
  }
}

function matchesSimpleSelector(el, selector) {
  if (!selector || selector === "*") return true;
  if (selector.includes(" ")) {
    const tail = selector.trim().split(/\s+/).at(-1);
    return matchesSimpleSelector(el, tail);
  }
  if (selector.startsWith("#")) return el.id === selector.slice(1);
  if (selector.startsWith(".")) return el.classList.contains(selector.slice(1));
  if (selector.startsWith("[")) {
    const match = selector.match(/^\[([^=\]]+)(?:=['"]?([^'"\]]+)['"]?)?\]$/);
    if (!match) return false;
    const [, name, expected] = match;
    const actual = el.getAttribute(name);
    return expected === undefined ? actual != null : actual === expected;
  }
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

function dataKey(attributeName) {
  return attributeName.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}
