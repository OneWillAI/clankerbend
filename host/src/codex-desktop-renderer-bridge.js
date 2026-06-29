(function installCodexVimNavigator() {
  const VIM_NAV_APP_ID = "onewill.vim-nav";
  const BRIDGE_VERSION = 115;
  const RUNTIME_KEY = "__clankerbendRuntime";
  const STYLE_ID = "codex-vim-nav-style";
  const ANNOTATION_CLASS = "codex-vim-nav-annotation";
  const ANCHOR_CLASS = "codex-vim-nav-anchor";
  const CURRENT_CLASS = "codex-vim-nav-current";
  const HIGHLIGHT_CLASS = "codex-vim-nav-highlight";
  const STATUS_CHROME_CLASS = "codex-vim-nav-status-chrome";
  const MODE_BADGE_ID = "codex-vim-nav-mode-badge";
  const HOST_UI_CLASS = "clankerbend-host-ui";
  const SELECTION_MENU_ID = "clankerbend-selection-menu";
  const ACCOUNT_SWITCHER_ID = "clankerbend-account-switcher";
  const OVERLAY_ID = "clankerbend-anchored-overlay";
  const COMPOSER_CHIPS_ID = "clankerbend-composer-chips";
  const SELECTOR = [
    "[data-content-search-unit-key]",
    "[data-turn-key]",
    "[data-content-search-turn-key]",
    "[data-thread-user-message-navigation-item-id]"
  ].join(",");

  const existingBridge = clankerbendRuntime().getBridge(VIM_NAV_APP_ID);
  if (existingBridge?.name === "vim-nav" && existingBridge?.version === BRIDGE_VERSION) {
    return existingBridge.snapshot();
  }
  if (typeof window.__codexVimNavCleanup === "function") {
    window.__codexVimNavCleanup();
  }

  const state = {
    version: BRIDGE_VERSION,
    name: "vim-nav",
    currentAnchorId: null,
    currentIndexValue: 0,
    vimMode: false,
    helpOpen: false,
    badgeHidden: readBadgeHidden(),
    metaDown: false,
    altDown: false,
    metaAltToggleDown: false,
    pendingKeys: "",
    countPrefix: "",
    anchorOrder: [],
    anchorIdByIndex: Object.create(null),
    anchorOrderFrozen: false,
    transcriptOrderSource: null,
    indexingPromise: null,
    indexingStartedAt: 0,
    indexingGeneration: 0,
    panelOpenPromise: null,
    lastPanelResult: null,
    selection: null,
    keyEventCount: 0,
    lastKey: null,
    lastDigit: null,
    lastCommandResult: null,
    lastRelativeDebug: null,
    lastMountSearch: null,
    lastBottomJump: null,
    lastOrderFallback: null,
    commandChain: Promise.resolve(),
    relativeMoveInFlight: false,
    pendingRelativeDelta: 0,
    hostState: null,
    hostEvents: [],
    activeTextSelection: null,
    lastSelectionMenuAt: 0,
    renderedOverlaySignature: null,
    accountUiStatus: "",
    accountAddOpen: false,
    accountAddLabel: "",
    accountManageOpen: false,
    accountPendingAdoptId: null,
    accountPendingDeleteId: null,
    pendingComposerSubmission: null,
    submittedComposerSubmissions: []
  };
  let lastScrollContainer = null;

  function ensureStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.documentElement.appendChild(style);
    }
    style.textContent = `
      .${ANCHOR_CLASS} {
        position: relative !important;
      }
      .${ANNOTATION_CLASS} {
        display: inline-grid !important;
        place-items: center !important;
        min-width: 28px !important;
        height: 22px !important;
        border: 1px solid rgba(143, 199, 212, .48) !important;
        border-radius: 999px !important;
        background: rgba(10, 16, 20, .86) !important;
        color: #cfe6ec !important;
        font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
        letter-spacing: 0 !important;
        user-select: none !important;
        cursor: pointer !important;
      }
      .${ANNOTATION_CLASS}:hover {
        border-color: rgba(143, 199, 212, .9) !important;
        background: rgba(18, 34, 41, .96) !important;
      }
      .${CURRENT_CLASS} .${ANNOTATION_CLASS} {
        border-color: #8fc7d4 !important;
        box-shadow: 0 0 0 3px rgba(143, 199, 212, .22) !important;
        color: #ffffff !important;
      }
      .${HIGHLIGHT_CLASS} {
        outline: 3px solid #8fc7d4 !important;
        outline-offset: 3px !important;
        border-radius: 8px !important;
        box-shadow: 0 0 0 7px rgba(143, 199, 212, .18) !important;
      }
      .${STATUS_CHROME_CLASS} {
        display: none !important;
      }
      .${HOST_UI_CLASS} {
        font: 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        letter-spacing: 0 !important;
        color: #241f12 !important;
      }
      #${OVERLAY_ID} button,
      #${ACCOUNT_SWITCHER_ID} button,
      #${COMPOSER_CHIPS_ID} button {
        appearance: none !important;
        border: 0 !important;
        border-radius: 6px !important;
        background: transparent !important;
        color: inherit !important;
        cursor: pointer !important;
        font: 650 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        padding: 7px 8px !important;
      }
      #${ACCOUNT_SWITCHER_ID} {
        display: grid !important;
        gap: 7px !important;
        min-width: 220px !important;
        max-width: 320px !important;
        border-top: 1px solid rgba(148, 163, 184, .24) !important;
        border-bottom: 1px solid rgba(148, 163, 184, .18) !important;
        margin: 5px 0 !important;
        padding: 8px 4px !important;
        color: inherit !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-head {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 8px !important;
        padding: 0 6px !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-title {
        color: currentColor !important;
        font: 700 11px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        letter-spacing: 0 !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-status {
        color: color-mix(in srgb, currentColor 62%, transparent) !important;
        font: 500 11px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-list {
        display: grid !important;
        gap: 2px !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-row {
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) auto !important;
        align-items: center !important;
        gap: 5px !important;
        border-radius: 6px !important;
        padding: 2px !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-row.is-active {
        background: rgba(143, 199, 212, .14) !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-main {
        display: grid !important;
        min-width: 0 !important;
        border-radius: 5px !important;
        padding: 6px !important;
        text-align: left !important;
        color: inherit !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-main:hover,
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-icon:hover {
        background: rgba(148, 163, 184, .16) !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-label,
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-meta {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-label {
        font: 650 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-meta {
        color: color-mix(in srgb, currentColor 58%, transparent) !important;
        font: 500 11px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-icon {
        width: 28px !important;
        height: 28px !important;
        display: inline-grid !important;
        place-items: center !important;
        border-radius: 5px !important;
        color: color-mix(in srgb, currentColor 76%, transparent) !important;
        padding: 0 !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-actions {
        display: grid !important;
        grid-template-columns: 1fr 1fr !important;
        gap: 4px !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-actions button {
        border-radius: 5px !important;
        background: rgba(148, 163, 184, .12) !important;
        color: inherit !important;
        min-width: 0 !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-add-form {
        display: grid !important;
        gap: 6px !important;
        border-radius: 6px !important;
        background: rgba(148, 163, 184, .10) !important;
        padding: 6px !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-add-form input {
        width: 100% !important;
        min-width: 0 !important;
        border: 1px solid rgba(148, 163, 184, .32) !important;
        border-radius: 5px !important;
        background: rgba(0, 0, 0, .18) !important;
        color: inherit !important;
        font: 500 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        outline: none !important;
        padding: 7px 8px !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-add-form input:focus {
        border-color: rgba(143, 199, 212, .76) !important;
        box-shadow: 0 0 0 2px rgba(143, 199, 212, .18) !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-add-actions {
        display: grid !important;
        grid-template-columns: 1fr 1fr !important;
        gap: 4px !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-add-actions button {
        background: rgba(148, 163, 184, .14) !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage {
        display: grid !important;
        gap: 7px !important;
        border-top: 1px solid rgba(148, 163, 184, .18) !important;
        padding-top: 7px !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage-head {
        display: flex !important;
        align-items: baseline !important;
        justify-content: space-between !important;
        gap: 8px !important;
        padding: 0 6px !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage-head strong {
        font: 700 11px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage-head span {
        color: color-mix(in srgb, currentColor 58%, transparent) !important;
        font: 500 11px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage-list {
        display: grid !important;
        gap: 6px !important;
        max-height: 204px !important;
        overflow-y: auto !important;
        overscroll-behavior: contain !important;
        padding-right: 2px !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage-list::-webkit-scrollbar {
        width: 8px !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage-list::-webkit-scrollbar-thumb {
        border-radius: 999px !important;
        background: rgba(148, 163, 184, .34) !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage-row {
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) auto !important;
        align-items: center !important;
        gap: 7px !important;
        border-radius: 6px !important;
        background: rgba(148, 163, 184, .10) !important;
        padding: 6px !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage-title {
        display: grid !important;
        min-width: 0 !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage-title strong,
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage-title span {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage-title strong {
        font: 650 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage-title span {
        color: color-mix(in srgb, currentColor 58%, transparent) !important;
        font: 500 11px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage-actions {
        display: flex !important;
        align-items: center !important;
        justify-content: flex-end !important;
        gap: 4px !important;
      }
      #${ACCOUNT_SWITCHER_ID} .clankerbend-account-manage-actions button {
        background: rgba(148, 163, 184, .14) !important;
        white-space: nowrap !important;
        padding: 6px 7px !important;
      }
      #${ACCOUNT_SWITCHER_ID} button:disabled {
        cursor: default !important;
        opacity: .55 !important;
      }
      #${OVERLAY_ID} {
        position: fixed !important;
        z-index: 2147483004 !important;
        display: none !important;
        width: min(340px, calc(100vw - 32px)) !important;
        border: 1px solid rgba(205, 176, 64, .72) !important;
        border-radius: 8px !important;
        background: #ffd84f !important;
        box-shadow: 0 16px 36px rgba(0, 0, 0, .22) !important;
        padding: 12px !important;
      }
      #${OVERLAY_ID}.is-visible {
        display: grid !important;
        gap: 9px !important;
      }
      #${OVERLAY_ID} strong {
        font: 700 13px/1.25 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      }
      #${OVERLAY_ID} textarea,
      #${OVERLAY_ID} input {
        width: 100% !important;
        min-height: 92px !important;
        resize: vertical !important;
        border: 1px solid rgba(150, 120, 24, .34) !important;
        border-radius: 6px !important;
        background: #fff3bd !important;
        color: #241f12 !important;
        font: 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        padding: 9px !important;
      }
      #${OVERLAY_ID} .clankerbend-overlay-actions {
        display: flex !important;
        justify-content: flex-end !important;
        gap: 6px !important;
      }
      #${OVERLAY_ID} button {
        background: rgba(80, 65, 20, .78) !important;
        color: #fff7d7 !important;
      }
      #${OVERLAY_ID} button.clankerbend-overlay-secondary {
        background: transparent !important;
        color: rgba(58, 45, 12, .82) !important;
      }
      #${COMPOSER_CHIPS_ID} {
        position: absolute !important;
        z-index: 2147483002 !important;
        display: none !important;
        flex-wrap: wrap !important;
        gap: 7px !important;
        max-width: calc(100vw - 24px) !important;
        pointer-events: none !important;
      }
      #${COMPOSER_CHIPS_ID}.is-visible {
        display: flex !important;
      }
      #${COMPOSER_CHIPS_ID} .clankerbend-context-chip {
        display: inline-flex !important;
        align-items: center !important;
        gap: 5px !important;
        max-width: min(280px, calc(100vw - 84px)) !important;
        border: 1px solid rgba(217, 185, 68, .72) !important;
        border-radius: 999px !important;
        background: #ffef9a !important;
        box-shadow: 0 4px 12px rgba(0, 0, 0, .12) !important;
        color: #3a2f0c !important;
        font: 600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        padding: 5px 8px !important;
        pointer-events: auto !important;
      }
      .clankerbend-submitted-context-row .clankerbend-context-chip {
        display: inline-flex !important;
        align-items: center !important;
        gap: 5px !important;
        max-width: min(280px, calc(100vw - 84px)) !important;
        border: 1px solid rgba(217, 185, 68, .72) !important;
        border-radius: 999px !important;
        background: #ffef9a !important;
        color: #3a2f0c !important;
        font: 600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        padding: 5px 8px !important;
      }
      .clankerbend-submitted-context-row .clankerbend-context-chip::before {
        content: "□" !important;
        color: #8a7327 !important;
        font-size: 10px !important;
        line-height: 1 !important;
      }
      #${COMPOSER_CHIPS_ID} .clankerbend-context-chip::before {
        content: "□" !important;
        color: #8a7327 !important;
        font-size: 10px !important;
        line-height: 1 !important;
      }
      #${COMPOSER_CHIPS_ID} .clankerbend-context-chip span {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      #${COMPOSER_CHIPS_ID} .clankerbend-context-chip button {
        padding: 0 2px !important;
        color: #725f20 !important;
      }
      html,
      body,
      main,
      [role="main"],
      [data-testid="thread-scroll-container"],
      [data-thread-scroll-container],
      [data-scroll-container] {
        scroll-behavior: auto !important;
      }
      #${MODE_BADGE_ID} {
        position: fixed !important;
        right: 18px !important;
        bottom: 18px !important;
        z-index: 2147483002 !important;
        display: none !important;
        flex-direction: column !important;
        align-items: flex-start !important;
        gap: 5px !important;
        max-width: min(360px, calc(100vw - 36px)) !important;
        border: 1px solid rgba(143, 199, 212, .55) !important;
        border-radius: 8px !important;
        background: rgba(9, 14, 18, .94) !important;
        color: #e8f6fa !important;
        box-shadow: 0 12px 30px rgba(0, 0, 0, .36) !important;
        padding: 8px 10px !important;
        font: 600 12px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace !important;
        letter-spacing: 0 !important;
        user-select: none !important;
      }
      #${MODE_BADGE_ID}.is-visible {
        display: flex !important;
      }
      #${MODE_BADGE_ID}.is-active {
        border-color: rgba(143, 199, 212, .82) !important;
        background: rgba(9, 14, 18, .97) !important;
      }
      #${MODE_BADGE_ID}:not(.is-active) {
        opacity: .76 !important;
      }
      #${MODE_BADGE_ID} strong {
        color: #8fc7d4 !important;
      }
      #${MODE_BADGE_ID} .codex-vim-nav-title-row {
        display: flex !important;
        align-items: baseline !important;
        gap: 7px !important;
        white-space: nowrap !important;
      }
      #${MODE_BADGE_ID} .codex-vim-nav-dismiss {
        margin-left: auto !important;
        border: 0 !important;
        border-radius: 4px !important;
        background: transparent !important;
        color: #7f9299 !important;
        padding: 0 3px !important;
        font: 700 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
        cursor: pointer !important;
      }
      #${MODE_BADGE_ID} .codex-vim-nav-dismiss:hover {
        color: #e8f6fa !important;
        background: rgba(143, 199, 212, .12) !important;
      }
      #${MODE_BADGE_ID} .codex-vim-nav-state {
        color: #e8f6fa !important;
      }
      #${MODE_BADGE_ID} .codex-vim-nav-help-toggle {
        border: 1px solid rgba(143, 199, 212, .34) !important;
        border-radius: 999px !important;
        background: rgba(143, 199, 212, .08) !important;
        color: #cfe6ec !important;
        padding: 0 5px !important;
        font: 700 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace !important;
        cursor: pointer !important;
      }
      #${MODE_BADGE_ID} .codex-vim-nav-help-toggle:hover {
        border-color: rgba(143, 199, 212, .75) !important;
        background: rgba(143, 199, 212, .16) !important;
      }
      #${MODE_BADGE_ID} span {
        color: #aab8be !important;
        font-weight: 500 !important;
      }
      #${MODE_BADGE_ID} .codex-vim-nav-title-row span {
        font-size: 11px !important;
      }
      #${MODE_BADGE_ID} .codex-vim-nav-help-row {
        display: block !important;
        white-space: nowrap !important;
      }
      #${MODE_BADGE_ID} .codex-vim-nav-help-menu {
        display: grid !important;
        grid-template-columns: auto 1fr !important;
        column-gap: 8px !important;
        row-gap: 3px !important;
        border-top: 1px solid rgba(143, 199, 212, .22) !important;
        margin-top: 3px !important;
        padding-top: 6px !important;
      }
      #${MODE_BADGE_ID} .codex-vim-nav-help-menu kbd {
        color: #e8f6fa !important;
        font: 700 11px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace !important;
      }
      #${MODE_BADGE_ID} .codex-vim-nav-help-menu span {
        white-space: nowrap !important;
      }
      #${MODE_BADGE_ID} .codex-vim-nav-key-buffer {
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
      }
      #${MODE_BADGE_ID} code {
        border: 1px solid rgba(143, 199, 212, .34) !important;
        border-radius: 5px !important;
        background: rgba(143, 199, 212, .12) !important;
        color: #e8f6fa !important;
        padding: 2px 5px !important;
        font: 700 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
      }
      @media (max-width: 900px) {
        .${ANNOTATION_CLASS} {
          display: inline-grid !important;
        }
      }
    `;
  }

  function ensureModeBadge() {
    ensureStyle();
    let badge = document.getElementById(MODE_BADGE_ID);
    if (!badge) {
      badge = document.createElement("div");
      badge.id = MODE_BADGE_ID;
      document.documentElement.appendChild(badge);
    }
    renderModeBadge(badge);
    badge.classList.toggle("is-visible", shouldShowModeBadge());
    badge.classList.toggle("is-active", state.vimMode);
    badge.classList.toggle("is-help-open", state.helpOpen);
  }

  function currentKeyBufferLabel() {
    if (state.countPrefix) return state.countPrefix;
    if (state.pendingKeys) return state.pendingKeys;
    return "";
  }

  function renderModeBadge(badge = document.getElementById(MODE_BADGE_ID)) {
    if (!badge) return;
    const buffer = currentKeyBufferLabel();
    badge.replaceChildren();
    const titleRow = document.createElement("div");
    titleRow.className = "codex-vim-nav-title-row";
    const title = document.createElement("strong");
    title.textContent = "VimNav";
    const mode = document.createElement("span");
    mode.className = "codex-vim-nav-state";
    mode.textContent = `[${state.vimMode ? "ON" : "OFF"}]`;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "codex-vim-nav-dismiss";
    dismiss.textContent = "x";
    dismiss.title = "Hide VimNav badge until Cmd-Option";
    dismiss.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideModeBadge();
    });
    titleRow.append(title, mode, dismiss);
    badge.appendChild(titleRow);
    const toggleRow = document.createElement("span");
    toggleRow.className = "codex-vim-nav-help-row";
    const helpButton = document.createElement("button");
    helpButton.type = "button";
    helpButton.className = "codex-vim-nav-help-toggle";
    helpButton.textContent = "?";
    helpButton.title = "Toggle VimNav help";
    const activateHelp = (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      if (event.type === "click" && helpButton.dataset.clankerbendPressed === "true") {
        helpButton.dataset.clankerbendPressed = "";
        return;
      }
      if (event.type !== "click" && helpButton.dataset.clankerbendPressed === "true") return;
      if (event.type !== "click") helpButton.dataset.clankerbendPressed = "true";
      toggleHelp();
    };
    helpButton.addEventListener("pointerdown", activateHelp);
    helpButton.addEventListener("mousedown", activateHelp);
    helpButton.addEventListener("touchstart", activateHelp, { passive: false });
    helpButton.addEventListener("click", activateHelp);
    toggleRow.append("(Cmd-Option toggles, ", helpButton, " for help)");
    badge.appendChild(toggleRow);
    if (buffer) {
      const row = document.createElement("div");
      row.className = "codex-vim-nav-key-buffer";
      const keyState = document.createElement("span");
      keyState.textContent = "keys";
      const code = document.createElement("code");
      code.textContent = buffer;
      row.append(keyState, code);
      badge.appendChild(row);
    }
    if (state.helpOpen) {
      const help = document.createElement("div");
      help.className = "codex-vim-nav-help-menu";
      for (const [keys, description] of [
        ["j / k", "previous or next transcript item"],
        ["gg / G", "first or last transcript item"],
        ["67G", "jump to transcript item 67"],
        ["{ / }", "previous or next user message"],
        ["[ / ]", "align current item top or bottom"],
        ["Backspace", "edit buffered keys"],
        ["i / Esc", "exit VimNav"]
      ]) {
        const keyEl = document.createElement("kbd");
        keyEl.textContent = keys;
        const descEl = document.createElement("span");
        descEl.textContent = description;
        help.append(keyEl, descEl);
      }
      badge.appendChild(help);
    }
  }

  function toggleHelp() {
    state.badgeHidden = false;
    writeBadgeHidden();
    state.helpOpen = !state.helpOpen;
    ensureModeBadge();
  }

  function shouldShowModeBadge() {
    if (state.vimMode || state.helpOpen || currentKeyBufferLabel()) return true;
    if (state.badgeHidden) return false;
    return anchorElements().length > 0;
  }

  function hideModeBadge() {
    state.vimMode = false;
    state.helpOpen = false;
    state.pendingKeys = "";
    state.countPrefix = "";
    state.badgeHidden = true;
    writeBadgeHidden();
    ensureModeBadge();
  }

  function setVimMode(enabled) {
    state.vimMode = Boolean(enabled);
    state.pendingKeys = "";
    state.countPrefix = "";
    if (state.vimMode) {
      state.badgeHidden = false;
      writeBadgeHidden();
    }
    if (state.vimMode) {
      setCurrentToBottomVisibleAnchor();
      focusTranscriptForVimMode();
      requestAnimationFrame(() => focusTranscriptForVimMode());
      setTimeout(() => focusTranscriptForVimMode(), 120);
      primeAnchorOrder().finally(() => {
        ensureAnnotations();
        scheduleAnnotationRefresh();
      });
    }
    ensureModeBadge();
  }

  function setCurrentToBottomVisibleAnchor() {
    const mounted = mountedAnchorsByViewport();
    const visible = mounted
      .filter((item) => item.viewportBottom >= topVisibleInset() && item.viewportTop <= viewportSafeBottom())
      .sort((a, b) => b.viewportBottom - a.viewportBottom);
    const target = visible[0] ||
      mounted
        .map((item) => ({ ...item, distance: Math.abs(item.viewportBottom - viewportSafeBottom()) }))
        .sort((a, b) => a.distance - b.distance)[0];
    if (target) setCurrent(target.anchorId, "adapter", target.order - 1);
  }

  function focusTranscriptForVimMode() {
    if (!state.vimMode) return false;
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur?.();
    const current = state.currentAnchorId ? findAnchor(state.currentAnchorId) : null;
    const visible = viewportVisibleAnchors().sort((a, b) => b.viewportBottom - a.viewportBottom)[0];
    const target = current || (visible?.anchorId ? findAnchor(visible.anchorId) : null) || findScrollContainer() || document.body;
    if (!(target instanceof HTMLElement)) return false;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    state.lastFocusTarget = {
      tag: target.tagName,
      anchorId: anchorId(target) || target.querySelector?.(SELECTOR) && anchorId(target.querySelector(SELECTOR)) || null,
      at: Date.now()
    };
    return document.activeElement === target;
  }

  function readBadgeHidden() {
    try {
      return localStorage.getItem("codex-vim-nav:badge-hidden") === "true";
    } catch {
      return false;
    }
  }

  function writeBadgeHidden() {
    try {
      if (state.badgeHidden) localStorage.setItem("codex-vim-nav:badge-hidden", "true");
      else localStorage.removeItem("codex-vim-nav:badge-hidden");
    } catch {
      // Ignore storage failures in injected renderer contexts.
    }
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function anchorId(el) {
    return el?.dataset?.contentSearchUnitKey ||
      el?.dataset?.turnKey ||
      el?.dataset?.contentSearchTurnKey ||
      el?.dataset?.threadUserMessageNavigationItemId ||
      null;
  }

  function anchorKind(el) {
    if (el?.dataset?.contentSearchUnitKey) return "content-search-unit";
    if (el?.dataset?.turnKey) return "turn";
    if (el?.dataset?.contentSearchTurnKey) return "content-search-turn";
    if (el?.dataset?.threadUserMessageNavigationItemId) return "navigation-item";
    return "unknown";
  }

  function roleForAnchor(el) {
    const id = anchorId(el) || "";
    const text = previewText(el).toLowerCase();
    if (id.includes(":user")) return "user";
    if (id.includes(":assistant")) return "assistant";
    if (/approval|tool|command/.test(text)) return "tool";
    return undefined;
  }

  function previewText(el) {
    return (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 220);
  }

  function isContentUnitId(id) {
    return /:(user|assistant)$/.test(String(id || ""));
  }

  function contentUnitSortKey(id) {
    const match = String(id || "").match(/^(.*):(\d+):(user|assistant)$/);
    if (!match) return null;
    const unitIndex = Number(match[2]);
    if (!Number.isSafeInteger(unitIndex) || unitIndex < 0) return null;
    return {
      turnSearchKey: match[1],
      unitIndex,
      roleRank: match[3] === "user" ? 0 : 1
    };
  }

  function compareAnchorIds(a, b) {
    const aKey = contentUnitSortKey(a);
    const bKey = contentUnitSortKey(b);
    if (aKey && bKey) {
      return aKey.turnSearchKey.localeCompare(bKey.turnSearchKey) ||
        aKey.unitIndex - bKey.unitIndex ||
        aKey.roleRank - bKey.roleRank ||
        String(a).localeCompare(String(b));
    }
    if (aKey) return -1;
    if (bKey) return 1;
    return 0;
  }

  function isStatusAnchor(el) {
    const text = previewText(el);
    if (/^worked for\b/i.test(text) && text.length < 80) return true;
    if (/^(compact(ed|ion)?|rollback point|context summary)\b/i.test(text) && text.length < 140) return true;
    return false;
  }

  function hasUserContentUnit(el) {
    return Boolean(el.querySelector?.("[data-content-search-unit-key$=':0:user']"));
  }

  function hasContentUnit(el) {
    return Boolean(el.querySelector?.("[data-content-search-unit-key$=':user'],[data-content-search-unit-key$=':assistant']"));
  }

  function hideStatusChrome() {
    for (const el of document.querySelectorAll(`.${STATUS_CHROME_CLASS}`)) {
      if (!isStatusAnchor(el) || hasContentUnit(el)) el.classList.remove(STATUS_CHROME_CLASS);
    }
    const candidates = Array.from(document.querySelectorAll("button,[role='button'],div,span"))
      .filter((el) => el instanceof HTMLElement && isStatusAnchor(el) && !hasContentUnit(el));
    for (const el of candidates) {
      const container = el.closest("button,[role='button']") || el;
      if (container instanceof HTMLElement && !hasContentUnit(container)) {
        container.classList.add(STATUS_CHROME_CLASS);
      }
    }
  }

  function anchorElements() {
    const seen = new Set();
    const all = Array.from(document.querySelectorAll(SELECTOR))
      .filter((el) => el instanceof HTMLElement);
    const turnAnchors = all.filter((el) =>
      (el.dataset.turnKey || el.dataset.contentSearchTurnKey || el.dataset.threadUserMessageNavigationItemId) &&
      hasUserContentUnit(el) &&
      !isStatusAnchor(el)
    );
    const contentUnitAnchors = all.filter((el) =>
      el.dataset.contentSearchUnitKey &&
      isContentUnitId(el.dataset.contentSearchUnitKey) &&
      !isStatusAnchor(el)
    );
    const source = contentUnitAnchors.length ? contentUnitAnchors : turnAnchors.length ? turnAnchors : all;
    const candidates = all
      .filter((el) => source.includes(el))
      .filter((el) => {
        const id = anchorId(el);
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    if (!contentUnitAnchors.length && turnAnchors.length) {
      return candidates.filter((el) =>
        !candidates.some((other) => other !== el && other.contains(el))
      );
    }
    return candidates.filter((el) =>
      !candidates.some((other) => other !== el && el.contains(other))
    );
  }

  function rememberAnchorOrder(elements) {
    const observedIds = elements.map(anchorId).filter(Boolean);
    if (state.transcriptOrderSource === "app-server") {
      state.anchorOrderFrozen = true;
      return;
    }
    const merged = mergeAnchorOrder(observedIds);
    if (merged.usedSortKey) {
      state.anchorOrderFrozen = true;
      return;
    }
    state.anchorOrder = state.anchorOrder.filter((id, index, list) =>
      id && list.indexOf(id) === index
    );
    observedIds.forEach((id, observedIndex) => {
      if (state.anchorOrder.includes(id)) return;
      if (state.anchorOrderFrozen) {
        mergeAnchorOrder([id]);
        return;
      }
      for (let i = observedIndex + 1; i < observedIds.length; i += 1) {
        const nextKnownIndex = state.anchorOrder.indexOf(observedIds[i]);
        if (nextKnownIndex >= 0) {
          state.anchorOrder.splice(nextKnownIndex, 0, id);
          return;
        }
      }
      for (let i = observedIndex - 1; i >= 0; i -= 1) {
        const previousKnownIndex = state.anchorOrder.indexOf(observedIds[i]);
        if (previousKnownIndex >= 0) {
          state.anchorOrder.splice(previousKnownIndex + 1, 0, id);
          return;
        }
      }
      state.anchorOrder.push(id);
    });
  }

  function mergeAnchorOrder(ids) {
    const dedupedKnownIds = [...state.anchorOrder, ...ids]
      .filter(Boolean)
      .filter((id, index, list) => list.indexOf(id) === index);
    const sortableIds = dedupedKnownIds.filter((id) => contentUnitSortKey(id));
    const fallbackIds = dedupedKnownIds.filter((id) => !contentUnitSortKey(id));
    if (sortableIds.length) {
      state.anchorOrder = [...sortableIds.sort(compareAnchorIds), ...fallbackIds];
    } else {
      state.anchorOrder = dedupedKnownIds;
    }
    rebuildAnchorIndex();
    return { usedSortKey: Boolean(sortableIds.length), count: state.anchorOrder.length };
  }

  function appendUnknownAnchors(ids) {
    const seen = new Set(state.anchorOrder);
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      state.anchorOrder.push(id);
      seen.add(id);
    }
    rebuildAnchorIndex();
  }

  function mountedUnknownContentAnchorIds() {
    if (state.transcriptOrderSource !== "app-server") return [];
    const known = new Set(state.anchorOrder);
    return collectAnchorIds().filter((id) =>
      isContentUnitId(id) && !known.has(id)
    );
  }

  function rebuildAnchorIndex() {
    state.anchorIdByIndex = Object.create(null);
    state.anchorOrder.forEach((id, index) => {
      state.anchorIdByIndex[index] = id;
    });
  }

  function mountedAnchorIds(elements) {
    const seen = new Set();
    return elements.map(anchorId).filter((id) => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function mountedOrderSource(ids) {
    return ids.some((id) => contentUnitSortKey(id)) ? "content-search-unit-sort-key" : "mounted-dom-order";
  }

  function replaceStaleFrozenOrder(elements) {
    if (!state.anchorOrderFrozen || state.transcriptOrderSource !== "app-server" || !state.anchorOrder.length) return false;
    const ids = mountedAnchorIds(elements);
    if (!ids.length || ids.some((id) => state.anchorOrder.includes(id))) return false;
    const source = mountedOrderSource(ids);
    state.anchorOrder = source === "content-search-unit-sort-key" ? [...ids].sort(compareAnchorIds) : ids;
    rebuildAnchorIndex();
    state.anchorOrderFrozen = true;
    state.transcriptOrderSource = source;
    if (state.currentAnchorId && !state.anchorOrder.includes(state.currentAnchorId)) state.currentAnchorId = null;
    state.lastOrderFallback = {
      reason: "stale-app-server-order",
      mountedCount: ids.length,
      replacedCount: state.anchorOrder.length,
      source,
      at: Date.now()
    };
    return true;
  }

  function anchorNumber(id) {
    const index = state.anchorOrder.indexOf(id);
    return index >= 0 ? index + 1 : state.anchorOrder.length + 1;
  }

  function hasStableIndex() {
    return state.anchorOrderFrozen && ["app-server", "content-search-unit-sort-key", "mounted-dom-order"].includes(state.transcriptOrderSource);
  }

  function markerGlyph(item) {
    return hasStableIndex() ? String(item.order) : "?";
  }

  function findScrollContainer() {
    const anchors = anchorElements();
    const explicit = [
      "[data-testid='thread-scroll-container']",
      "[data-thread-scroll-container]",
      "[data-scroll-container]",
      "main [class*='overflow-y-auto']",
      "main [class*='overflow-auto']"
    ];
    for (const selector of explicit) {
      const el = document.querySelector(selector);
      if (isScrollable(el)) return rememberScrollContainer(el);
    }
    const candidates = Array.from(document.querySelectorAll("main, main *, [role='main'], [role='main'] *, body *"))
      .filter(isScrollable)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          el,
          count: anchors.filter((anchor) => el.contains(anchor)).length,
          overflow: el.scrollHeight - el.clientHeight,
          area: Math.max(0, rect.width) * Math.max(0, rect.height)
        };
      })
      .sort((a, b) => b.count - a.count || b.overflow - a.overflow || b.area - a.area);
    if (candidates[0]?.el) return rememberScrollContainer(candidates[0].el);
    if (lastScrollContainer?.isConnected) return lastScrollContainer;
    return document.scrollingElement || document.documentElement;
  }

  function rememberScrollContainer(root) {
    if (root) lastScrollContainer = root;
    return root;
  }

  function isScrollable(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.scrollHeight <= el.clientHeight + 4) return false;
    const style = window.getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`);
  }

  function selectorForAnchor(id) {
    const escaped = cssEscape(id);
    return [
      `[data-content-search-unit-key="${escaped}"]`,
      `[data-turn-key="${escaped}"]`,
      `[data-content-search-turn-key="${escaped}"]`,
      `[data-thread-user-message-navigation-item-id="${escaped}"]`
    ].join(",");
  }

  function findAnchor(id) {
    return document.querySelector(selectorForAnchor(id));
  }

  function markerForAnchor(el, id) {
    return el?.querySelector?.(`.${ANNOTATION_CLASS}[data-anchor-id="${cssEscape(id)}"]`) || el;
  }

  function scrollTargetForAnchor(el, id, options = {}) {
    return el;
  }

  function isDocumentScrollRoot(root) {
    return root === document.scrollingElement || root === document.documentElement || root === document.body;
  }

  function nearestScrollContainer(el) {
    for (let node = el?.parentElement; node; node = node.parentElement) {
      if (isScrollable(node)) return node;
    }
    return findScrollContainer();
  }

  function isHostUiElement(el) {
    for (let node = el; node; node = node.parentElement) {
      if (node.classList?.contains?.(HOST_UI_CLASS)) return true;
      if (node.id === SELECTION_MENU_ID || node.id === OVERLAY_ID || node.id === COMPOSER_CHIPS_ID) return true;
    }
    return false;
  }

  function scrollTopOf(root) {
    return isDocumentScrollRoot(root) ? window.scrollY : root.scrollTop;
  }

  function withInstantScroll(root, fn) {
    const nodes = [
      document.documentElement,
      document.body,
      root instanceof HTMLElement ? root : null
    ].filter(Boolean);
    const previous = nodes.map((node) => [node, node.style.scrollBehavior]);
    for (const node of nodes) node.style.scrollBehavior = "auto";
    try {
      return fn();
    } finally {
      for (const [node, value] of previous) node.style.scrollBehavior = value;
    }
  }

  function scrollRootRange(root) {
    if (isDocumentScrollRoot(root)) {
      return {
        min: 0,
        max: Math.max(
          0,
          Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight
        )
      };
    }
    const max = Math.max(0, (root.scrollHeight || 0) - (root.clientHeight || 0));
    const style = getComputedStyle(root);
    if (style.flexDirection === "column-reverse") {
      return { min: -max, max: 0 };
    }
    return { min: 0, max };
  }

  function scrollTopForViewportDelta(root, delta) {
    const currentTop = scrollTopOf(root);
    if (!isDocumentScrollRoot(root) && getComputedStyle(root).flexDirection === "column-reverse") {
      return currentTop - delta;
    }
    return currentTop + delta;
  }

  function scrollRootTo(root, top) {
    const range = scrollRootRange(root);
    const clampedTop = Math.max(range.min, Math.min(range.max, Number.isFinite(top) ? top : 0));
    withInstantScroll(root, () => {
      if (isDocumentScrollRoot(root)) {
        window.scrollTo(0, clampedTop);
        document.documentElement.scrollTop = clampedTop;
        document.body.scrollTop = clampedTop;
        return;
      }
      root.scrollTop = clampedTop;
    });
  }

  function scrollableAncestors(el) {
    const roots = [];
    for (let node = el?.parentElement; node; node = node.parentElement) {
      if (isScrollable(node)) roots.push(node);
    }
    const found = findScrollContainer();
    if (found && !roots.includes(found)) roots.push(found);
    const doc = document.scrollingElement || document.documentElement;
    if (doc && !roots.includes(doc)) roots.push(doc);
    return roots;
  }

  function bottomScrollRoots() {
    const roots = [];
    const add = (root) => {
      if (root && !roots.includes(root)) roots.push(root);
    };
    add(lastScrollContainer);
    add(findScrollContainer());
    add(nearestScrollContainer(findAnchor(state.currentAnchorId) || anchorElements()[0] || document.body));
    add(document.scrollingElement || document.documentElement);
    Array.from(document.querySelectorAll("main, main *, [role='main'], [role='main'] *, body *"))
      .filter(isScrollable)
      .map((el) => ({
        el,
        overflow: Math.max(0, el.scrollHeight - el.clientHeight),
        area: Math.max(0, el.getBoundingClientRect().width) * Math.max(0, el.getBoundingClientRect().height)
      }))
      .sort((a, b) => b.overflow - a.overflow || b.area - a.area)
      .slice(0, 6)
      .forEach((candidate) => add(candidate.el));
    return roots;
  }

  function topVisibleInset() {
    const blockers = Array.from(document.querySelectorAll("body *"))
      .map((el) => {
        if (!(el instanceof HTMLElement)) return null;
        if (isHostUiElement(el)) return null;
        const style = getComputedStyle(el);
        if (!/(fixed|sticky)/.test(style.position)) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width < window.innerWidth * 0.25 || rect.height < 20 || rect.height > 140) return null;
        if (rect.top > 4 || rect.bottom < 24) return null;
        if (rect.right < window.innerWidth * 0.25 || rect.left > window.innerWidth * 0.75) return null;
        return rect.bottom;
      })
      .filter((bottom) => Number.isFinite(bottom));
    const headerBottom = blockers.length ? Math.max(...blockers) : 0;
    return Math.min(Math.max(headerBottom, 0), Math.min(140, window.innerHeight * 0.2));
  }

  function bottomVisibleInset() {
    const blockers = Array.from(document.querySelectorAll("body *"))
      .map((el) => {
        if (!(el instanceof HTMLElement)) return null;
        if (isHostUiElement(el)) return null;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (rect.width < window.innerWidth * 0.25 || rect.height < 24 || rect.height > window.innerHeight * 0.45) return null;
        if (rect.bottom < window.innerHeight - 6 || rect.top > window.innerHeight - 24) return null;
        if (rect.right < window.innerWidth * 0.25 || rect.left > window.innerWidth * 0.75) return null;
        const isAnchored = /(fixed|sticky)/.test(style.position);
        const isComposer = Boolean(el.matches("form, textarea, input, [contenteditable='true'], [role='textbox']") ||
          el.querySelector?.("textarea, input, [contenteditable='true'], [role='textbox']"));
        if (!isAnchored && !isComposer) return null;
        return window.innerHeight - rect.top;
      })
      .filter((height) => Number.isFinite(height));
    const blockerHeight = blockers.length ? Math.max(...blockers) : 0;
    return Math.min(Math.max(blockerHeight, 0), Math.min(320, window.innerHeight * 0.45));
  }

  function composerVisibleInset() {
    const anchor = composerAnchorElement();
    const rect = anchor?.getBoundingClientRect?.();
    if (!rect || rect.bottom < window.innerHeight * 0.5 || rect.top > window.innerHeight) return 0;
    return Math.min(Math.max(0, window.innerHeight - rect.top), Math.min(320, window.innerHeight * 0.45));
  }

  function viewportSafeBottom() {
    return window.innerHeight - Math.max(bottomVisibleInset(), composerVisibleInset());
  }

  function viewportTargetTop(target, options = {}) {
    const padding = 8;
    const rect = target.getBoundingClientRect();
    const minTop = topVisibleInset() + padding;
    const maxTop = Math.max(minTop, viewportSafeBottom() - rect.height - padding);
    if (options.block === "end") return maxTop;
    if (options.block === "center") {
      return Math.max(minTop, Math.min(maxTop, (window.innerHeight / 2) - (rect.height / 2)));
    }
    return minTop;
  }

  function viewportAlignmentDistance(target, options = {}) {
    const padding = 8;
    const rect = target.getBoundingClientRect();
    if (options.block === "end") return rect.bottom - viewportSafeBottom() + padding;
    return rect.top - viewportTargetTop(target, options);
  }

  function tryViewportCorrection(target, options = {}) {
    if (!(target instanceof HTMLElement)) return false;
    const distance = () => viewportAlignmentDistance(target, options);
    let delta = distance();
    if (Math.abs(delta) <= 4) return true;
    for (let pass = 0; pass < 6; pass += 1) {
      let improved = false;
      for (const root of scrollableAncestors(target)) {
        const beforeDistance = Math.abs(distance());
        const originalTop = scrollTopOf(root);
        const candidates = [
          scrollTopForViewportDelta(root, delta),
          scrollTopForViewportDelta(root, -delta),
          originalTop + delta,
          originalTop - delta
        ];
        let bestTop = originalTop;
        let bestDistance = beforeDistance;
        for (const top of candidates) {
          scrollRootTo(root, top);
          const candidateDistance = Math.abs(distance());
          if (candidateDistance < bestDistance) {
            bestDistance = candidateDistance;
            bestTop = scrollTopOf(root);
          }
          scrollRootTo(root, originalTop);
        }
        if (bestDistance + 2 < beforeDistance) {
          scrollRootTo(root, bestTop);
          if (bestDistance <= 8) return true;
          delta = distance();
          improved = true;
          break;
        }
      }
      if (!improved) break;
    }
    return Math.abs(distance()) <= 8;
  }

  function nativeScrollThenCorrect(target, options = {}) {
    if (!(target instanceof HTMLElement)) return false;
    try {
      target.scrollIntoView({
        block: options.block === "end" ? "end" : options.block === "center" ? "center" : "start",
        inline: "nearest",
        behavior: "instant"
      });
    } catch {
      target.scrollIntoView(options.block === "end" ? false : true);
    }
    return tryViewportCorrection(target, options);
  }

  function scrollAnchorIntoView(el, id, options = {}) {
    const target = scrollTargetForAnchor(el, id, options);
    const root = rememberScrollContainer(nearestScrollContainer(target));
    const deltaFor = () => {
      const rootRect = root.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const padding = 8;
      if (options.block === "start") return targetRect.top - Math.max(rootRect.top, topVisibleInset()) - padding;
      if (options.block === "end") return targetRect.bottom - Math.min(rootRect.bottom, viewportSafeBottom()) + padding;
      return targetRect.top + (targetRect.height / 2) - (rootRect.top + rootRect.height / 2);
    };
    const delta = deltaFor();
    const before = scrollTopOf(root);
    const nextTop = isDocumentScrollRoot(root) ? Math.max(0, before + delta) : scrollTopForViewportDelta(root, delta);
    scrollRootTo(root, nextTop);
    if (Math.abs(delta) > 2 && Math.abs(scrollTopOf(root) - before) < 1) {
      tryViewportCorrection(target, options);
    }
    if (!tryViewportCorrection(target, options)) {
      nativeScrollThenCorrect(target, options);
    }
    const correctFreshAlignment = () => {
      const freshEl = findAnchor(id);
      if (!(freshEl instanceof HTMLElement)) return;
      const freshTarget = scrollTargetForAnchor(freshEl, id, options);
      if (!freshTarget.isConnected) return;
      if (tryViewportCorrection(freshTarget, options) || nativeScrollThenCorrect(freshTarget, options)) return;
      const freshRoot = nearestScrollContainer(freshTarget);
      const rootRect = freshRoot.getBoundingClientRect();
      const targetRect = freshTarget.getBoundingClientRect();
      const padding = 8;
      let correction = 0;
      if (options.block === "start") {
        correction = targetRect.top - Math.max(rootRect.top, topVisibleInset()) - padding;
      } else if (options.block === "end") {
        correction = targetRect.bottom - Math.min(rootRect.bottom, viewportSafeBottom()) + padding;
      } else {
        correction = targetRect.top + (targetRect.height / 2) - (rootRect.top + rootRect.height / 2);
      }
      if (Math.abs(correction) > 4) {
        const correctedTop = isDocumentScrollRoot(freshRoot)
          ? Math.max(0, scrollTopOf(freshRoot) + correction)
          : scrollTopForViewportDelta(freshRoot, correction);
        scrollRootTo(freshRoot, correctedTop);
      }
    };
    correctFreshAlignment();
  }

  function anchors() {
    const root = findScrollContainer();
    const rootRect = root.getBoundingClientRect();
    const elements = anchorElements();
    replaceStaleFrozenOrder(elements);
    rememberAnchorOrder(elements);
    return elements.filter((el) =>
      !state.anchorOrderFrozen || state.anchorOrder.includes(anchorId(el))
    ).map((el) => {
      const id = anchorId(el);
      const rect = el.getBoundingClientRect();
      const visible = rect.bottom >= rootRect.top &&
        rect.top <= rootRect.bottom &&
        rect.right >= rootRect.left &&
        rect.left <= rootRect.right;
      return {
        anchorId: id,
        kind: anchorKind(el),
        visible,
        top: Math.round(rect.top - rootRect.top),
        height: Math.round(rect.height),
        textPreview: previewText(el),
        order: anchorNumber(id),
        indexed: hasStableIndex(),
        inferredRole: roleForAnchor(el)
      };
    }).sort((a, b) => a.order - b.order);
  }

  function viewportVisibleAnchors(items = anchors()) {
    return items.map((item) => {
      const el = findAnchor(item.anchorId);
      const marker = markerForAnchor(el, item.anchorId);
      const rect = marker?.getBoundingClientRect?.() || el?.getBoundingClientRect?.();
      return { ...item, viewportTop: rect?.top ?? item.top, viewportBottom: rect?.bottom ?? (item.top + item.height) };
    }).filter((item) =>
      item.viewportBottom >= topVisibleInset() &&
      item.viewportTop <= viewportSafeBottom()
    );
  }

  function collectAnchorIds() {
    const seen = new Set();
    return anchorElements()
      .map(anchorId)
      .filter((id) => {
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
  }

  function hasAppServerOrder() {
    return state.transcriptOrderSource === "app-server" && state.anchorOrder.length > 0;
  }

  function orderPendingResult() {
    ensureStyle();
    ensureModeBadge();
    return {
      ok: false,
      pending: true,
      error: "app-server transcript order pending"
    };
  }

  async function runPrimeAnchorOrder(generation) {
    ensureStyle();
    ensureModeBadge();
    hideStatusChrome();
    if (generation !== state.indexingGeneration) return { ok: false, error: "stale index generation" };
    if (!hasAppServerOrder()) return orderPendingResult();
    const currentId = state.currentAnchorId;
    anchors();
    state.anchorOrderFrozen = true;
    if (currentId && findAnchor(currentId)) setCurrent(currentId, "adapter");
    ensureAnnotations();
    return {
      ok: true,
      count: state.anchorOrder.length,
      source: state.transcriptOrderSource ||
        (Object.keys(state.anchorIdByIndex).length ? "content-search-unit-sort-key" : "mounted-dom-order")
    };
  }

  function primeAnchorOrder() {
    if (!hasAppServerOrder()) return Promise.resolve(orderPendingResult());
    if (state.anchorOrderFrozen) {
      anchors();
      ensureAnnotations();
      return Promise.resolve({
        ok: true,
        count: state.anchorOrder.length,
        cached: true,
        source: state.transcriptOrderSource ||
          (Object.keys(state.anchorIdByIndex).length ? "content-search-unit-sort-key" : "mounted-dom-order")
      });
    }
    if (state.indexingPromise && Date.now() - state.indexingStartedAt < 15000) return state.indexingPromise;
    const generation = state.indexingGeneration + 1;
    state.indexingGeneration = generation;
    state.indexingStartedAt = Date.now();
    state.indexingPromise = runPrimeAnchorOrder(generation).finally(() => {
      state.indexingPromise = null;
      state.indexingStartedAt = 0;
    });
    return state.indexingPromise;
  }

  function freezeCurrentDomOrder(options = {}) {
    const selectCurrent = options.selectCurrent !== false;
    const annotate = options.annotate !== false;
    const ids = collectAnchorIds();
    if (!ids.length) return { ok: false, error: "no transcript anchors" };
    state.anchorIdByIndex = Object.create(null);
    state.anchorOrder = ids.some((id) => contentUnitSortKey(id)) ? [...ids].sort(compareAnchorIds) : ids;
    rebuildAnchorIndex();
    state.anchorOrderFrozen = true;
    state.transcriptOrderSource = mountedOrderSource(ids);
    if (!selectCurrent) {
      if (state.currentAnchorId && !state.anchorOrder.includes(state.currentAnchorId)) state.currentAnchorId = null;
    } else if (!state.currentAnchorId || !state.anchorOrder.includes(state.currentAnchorId)) {
      setCurrentToBottomVisibleAnchor();
    } else {
      setCurrent(state.currentAnchorId, "adapter");
    }
    if (annotate) ensureAnnotations();
    return { ok: true, count: state.anchorOrder.length };
  }

  function withStableMountedIndex(command) {
    if (!hasAppServerOrder()) return orderPendingResult();
    if (!state.anchorOrderFrozen) state.anchorOrderFrozen = true;
    ensureAnnotations();
    return command();
  }

  function withVisibleMountedIndex(command) {
    if (!hasAppServerOrder()) {
      ensureAnnotations();
      return command();
    }
    return withStableMountedIndex(command);
  }

  function afterIndexing(command) {
    const run = () => {
      if (!hasAppServerOrder()) return orderPendingResult();
      ensureAnnotations();
      return command();
    };
    return run();
  }

  function ensureAnnotations() {
    ensureStyle();
    ensureModeBadge();
    hideStatusChrome();
    const ids = new Set();
    for (const item of anchors()) {
      if (!item.indexed) continue;
      ids.add(item.anchorId);
      const el = findAnchor(item.anchorId);
      if (!(el instanceof HTMLElement)) continue;
      el.classList.add(ANCHOR_CLASS);
      el.classList.toggle(CURRENT_CLASS, item.anchorId === state.currentAnchorId);
      let label = el.querySelector(`.${ANNOTATION_CLASS}[data-anchor-id="${cssEscape(item.anchorId)}"][data-clankerbend-app-id="${VIM_NAV_APP_ID}"]`);
      if (!label) {
        label = document.createElement("button");
        label.type = "button";
        label.className = ANNOTATION_CLASS;
        label.dataset.anchorId = item.anchorId;
        label.dataset.clankerbendAppId = VIM_NAV_APP_ID;
        label.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          event.stopPropagation();
          const anchorId = event.currentTarget?.dataset?.anchorId || item.anchorId;
          setCurrent(anchorId, "transcript");
          highlightAnchor(anchorId, { durationMs: 600 });
          setTimeout(() => {
            openPanel().catch(() => {});
          }, 0);
        });
      }
      label.textContent = markerGlyph(item);
      label.title = item.indexed
        ? `VimNav ${item.order}: ${item.inferredRole || item.kind}`
        : `VimNav index pending: ${item.inferredRole || item.kind}`;
      label.setAttribute("aria-label", label.title);
      clankerbendRuntime().placeAnnotation?.(el, {
        appId: VIM_NAV_APP_ID,
        anchorId: item.anchorId,
        markerId: `vim-nav:${item.anchorId}`,
        priority: 30,
        element: label
      }) || el.insertAdjacentElement("afterbegin", label);
    }
    clankerbendRuntime().removeAnnotations?.(VIM_NAV_APP_ID, ids);
    document.querySelectorAll(`.${ANNOTATION_CLASS}[data-clankerbend-app-id="${VIM_NAV_APP_ID}"]`).forEach((node) => {
      if (!ids.has(node.dataset.anchorId) && !node.closest(".clankerbend-transcript-annotation-slot")) node.remove();
    });
  }

  function setCurrent(id, source = "adapter", indexHint = null) {
    if (!id) return;
    state.currentAnchorId = id;
    if (Number.isInteger(indexHint)) {
      state.currentIndexValue = indexHint;
    } else {
      const index = state.anchorOrder.indexOf(id);
      if (index >= 0) state.currentIndexValue = index;
    }
    for (const el of document.querySelectorAll(`.${CURRENT_CLASS}`)) el.classList.remove(CURRENT_CLASS);
    findAnchor(id)?.classList.add(CURRENT_CLASS);
    state.selection = {
      selectionId: `sel_${Date.now()}`,
      source,
      appId: VIM_NAV_APP_ID,
      anchorId: id,
      entryId: `nav:${id}`,
      selectedAt: new Date().toISOString()
    };
  }

  function currentIndex() {
    const list = anchors();
    const index = state.anchorOrder.indexOf(state.currentAnchorId);
    if (index >= 0) {
      state.currentIndexValue = index;
      return index;
    }
    if (Number.isInteger(state.currentIndexValue) &&
        state.currentIndexValue >= 0 &&
        state.currentIndexValue < Math.max(state.anchorOrder.length, 1)) {
      return state.currentIndexValue;
    }
    const firstVisible = list.find((item) => item.visible) || list[0];
    state.currentIndexValue = firstVisible ? firstVisible.order - 1 : 0;
    return state.currentIndexValue;
  }

  function mountedTargetForIndex(index, direction = 0) {
    const list = anchors();
    if (!list.length) return null;
    const exact = list.find((item) => item.order - 1 === index);
    if (exact) return exact;
    if (direction < 0) {
      return [...list].reverse().find((item) => item.order - 1 <= index) || list[0];
    }
    if (direction > 0) {
      return list.find((item) => item.order - 1 >= index) || list[list.length - 1];
    }
    return list.reduce((nearest, item) =>
      Math.abs((item.order - 1) - index) < Math.abs((nearest.order - 1) - index) ? item : nearest
    , list[0]);
  }

  function mountedAnchorsByViewport() {
    return anchors()
      .map((item) => {
        const el = findAnchor(item.anchorId);
        const marker = markerForAnchor(el, item.anchorId);
        const rect = marker?.getBoundingClientRect?.() || el?.getBoundingClientRect?.();
        return {
          ...item,
          viewportTop: rect?.top ?? item.top,
          viewportBottom: rect?.bottom ?? (item.top + item.height)
        };
      })
      .sort((a, b) => a.viewportTop - b.viewportTop || a.viewportBottom - b.viewportBottom);
  }

  function jumpRelativeMounted(delta) {
    const list = mountedAnchorsByViewport();
    if (!list.length) return { ok: false, error: "no mounted transcript anchors" };
    const visible = list.filter((item) =>
      item.viewportBottom >= topVisibleInset() &&
      item.viewportTop <= viewportSafeBottom()
    );
    let baseIndex = list.findIndex((item) => item.anchorId === state.currentAnchorId);
    if (baseIndex < 0) {
      const fallback = delta < 0
        ? (visible[0] || list[0])
        : (visible[visible.length - 1] || list[list.length - 1]);
      baseIndex = Math.max(0, list.findIndex((item) => item.anchorId === fallback.anchorId));
    }
    const targetIndex = Math.max(0, Math.min(list.length - 1, baseIndex + delta));
    const target = list[targetIndex];
    if (!target) return { ok: false, error: "target transcript anchor not mounted" };
    setCurrent(target.anchorId, "adapter", target.order - 1);
    return scrollToAnchor(target.anchorId, {
      behavior: "auto",
      block: blockForAnchorVisibility(target.anchorId, "start"),
      indexHint: target.order - 1
    });
  }

  function mountedFloorTargetForIndex(index) {
    const visible = viewportVisibleAnchors(anchors()).sort((a, b) => a.order - b.order);
    const visibleExact = visible.find((item) => item.order - 1 === index);
    if (visibleExact) return visibleExact;

    const mounted = anchors().sort((a, b) => a.order - b.order);
    const mountedExact = mounted.find((item) => item.order - 1 === index);
    if (mountedExact) return mountedExact;
    const visibleFloor = [...visible].reverse().find((item) => item.order - 1 <= index);
    if (visibleFloor) return visibleFloor;
    return [...mounted].reverse().find((item) => item.order - 1 <= index) || mounted[0] || null;
  }

  function mountedBottomFloorTargetForIndex(index) {
    const mounted = anchors().sort((a, b) => a.order - b.order);
    const mountedExact = mounted.find((item) => item.order - 1 === index);
    if (mountedExact) return mountedExact;
    return [...mounted].reverse().find((item) => item.order - 1 <= index) || mounted[mounted.length - 1] || null;
  }

  function mountedResolutionForIndex(index) {
    const mounted = anchors().sort((a, b) => a.order - b.order);
    if (!mounted.length) return null;
    const exact = mounted.find((item) => item.order - 1 === index) || null;
    const floor = [...mounted].reverse().find((item) => item.order - 1 <= index) || null;
    const ceiling = mounted.find((item) => item.order - 1 >= index) || null;
    return {
      mounted,
      first: mounted[0].order - 1,
      last: mounted[mounted.length - 1].order - 1,
      exact,
      floor,
      ceiling
    };
  }

  function mountedIndexRange() {
    const mounted = anchors().sort((a, b) => a.order - b.order);
    if (!mounted.length) return null;
    return {
      first: mounted[0].order - 1,
      last: mounted[mounted.length - 1].order - 1,
      mounted
    };
  }

  function estimatedScrollTopForIndex(root, index) {
    const maxIndex = Math.max(lastKnownIndex(), 1);
    const range = scrollRootRange(root);
    const ratio = Math.max(0, Math.min(1, index / maxIndex));
    return range.min + ((range.max - range.min) * ratio);
  }

  async function mountTargetForIndex(index, direction = 0, options = {}) {
    const knownId = state.anchorIdByIndex[index] || (Object.keys(state.anchorIdByIndex).length ? null : state.anchorOrder[index]);
    const shouldResolveFloor = options.resolveMissing === "floor-on-overshoot";
    const preferExact = options.preferExact === true && Boolean(knownId);
    const isExactKnownTarget = (candidate) =>
      candidate && (!knownId || candidate.anchorId === knownId || candidate.order - 1 === index);
    const searchRoot = () => findScrollContainer() || nearestScrollContainer(anchorElements()[0] || findAnchor(state.currentAnchorId) || document.body);
    let root = searchRoot();
    const resolveMounted = () => {
      const resolution = mountedResolutionForIndex(index);
      if (!resolution) return null;
      if (isExactKnownTarget(resolution.exact)) return { target: resolution.exact, done: true };
      if (resolution.first <= index && index <= resolution.last) {
        if (preferExact) return { target: null, done: false, resolution, contained: true };
        const missingTarget = shouldResolveFloor
          ? resolution.floor
          : direction > 0
            ? resolution.ceiling || resolution.floor
            : direction < 0
              ? resolution.floor || resolution.ceiling
              : resolution.floor || resolution.ceiling;
        return { target: missingTarget, done: true, resolution };
      }
      return { target: null, done: false, resolution };
    };

    let resolved = resolveMounted();
    let target = resolved?.target || null;
    if (resolved?.done && target) return target;
    if (index <= 0) {
      scrollRootTo(root, scrollRootRange(root).min);
      await delay(450);
      anchors();
      target = mountedTargetForIndex(0, 1);
      return target && target.order - 1 === 0 ? target : target || null;
    }
    if (index >= lastKnownIndex()) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        root = searchRoot();
        scrollRootTo(root, scrollRootRange(root).max);
        await delay(180);
        anchors();
        target = mountedTargetForIndex(lastKnownIndex(), -1);
        if (target && target.order - 1 >= lastKnownIndex()) return target;
      }
      if (options.resolveMissing === "bottom-floor-on-end") return mountedBottomFloorTargetForIndex(index);
      return null;
    }
    if (options.approximate === true && state.anchorOrder.length > 1 && resolved?.resolution) {
      root = searchRoot();
      scrollRootTo(root, estimatedScrollTopForIndex(root, index));
      await delay(90);
      anchors();
      resolved = resolveMounted();
      target = resolved?.target || null;
      if (resolved?.done && target) return target;
    }
    {
      let travelDirection = direction || (resolved?.resolution
        ? (index < resolved.resolution.first ? -1 : index > resolved.resolution.last ? 1 : 0)
        : 0);
      if (travelDirection) {
        let previousFirst = resolved?.resolution?.first;
        let previousLast = resolved?.resolution?.last;
        const attempts = [];
        for (let attempt = 0; attempt < 36; attempt += 1) {
          root = searchRoot();
          const beforeResolution = resolved?.resolution || mountedResolutionForIndex(index);
          const viewport = Math.min(root.clientHeight || window.innerHeight || 720, 1100);
          const sparseRange = beforeResolution
            ? Math.max(0, beforeResolution.last - beforeResolution.first + 1 - beforeResolution.mounted.length)
            : 0;
          const upwardMultiplier = sparseRange > 6 ? 1.75 : 1.35;
          const step = travelDirection < 0
            ? Math.max(520, viewport * upwardMultiplier)
            : Math.max(240, Math.min(viewport, 900) * 0.82);
          const beforeTop = scrollTopOf(root);
          const wantedSign = travelDirection > 0 ? 1 : -1;
          const tryMove = async (sign) => {
            scrollRootTo(root, scrollTopForViewportDelta(root, sign * step));
            await delay(70);
            anchors();
            const movedResolution = mountedResolutionForIndex(index);
            const movedTop = scrollTopOf(root);
            const progress = !beforeResolution || !movedResolution ? 0 : travelDirection > 0
              ? Math.max(0, movedResolution.last - beforeResolution.last)
              : Math.max(0, beforeResolution.first - movedResolution.first);
            return { sign, movedTop, movedResolution, progress };
          };
          let move = await tryMove(wantedSign);
          if (!move.progress) {
            scrollRootTo(root, beforeTop);
            await delay(20);
            move = await tryMove(-wantedSign);
          }
          await delay(70);
          anchors();
          resolved = resolveMounted();
          target = resolved?.target || null;
          travelDirection = direction || (resolved?.resolution
            ? (index < resolved.resolution.first ? -1 : index > resolved.resolution.last ? 1 : 0)
            : travelDirection);
          attempts.push({
            attempt,
            wantedSign,
            usedSign: move.sign,
            beforeTop: Math.round(beforeTop),
            afterTop: Math.round(scrollTopOf(root)),
            beforeRange: beforeResolution ? [beforeResolution.first + 1, beforeResolution.last + 1] : null,
            afterRange: resolved?.resolution ? [resolved.resolution.first + 1, resolved.resolution.last + 1] : null,
            progress: move.progress
          });
          state.lastMountSearch = { index: index + 1, direction: travelDirection, attempts: attempts.slice(-6) };
          if (resolved?.done && target) return target;
          const nextFirst = resolved?.resolution?.first;
          const nextLast = resolved?.resolution?.last;
          const changedScroll = Math.abs(scrollTopOf(root) - beforeTop) > 1;
          const changedRange = nextFirst !== previousFirst || nextLast !== previousLast;
          const range = scrollRootRange(root);
          const atSearchEdge = travelDirection < 0
            ? scrollTopOf(root) <= range.min + 2
            : scrollTopOf(root) >= range.max - 2;
          if (!changedRange && atSearchEdge) {
            await delay(650);
            anchors();
            resolved = resolveMounted();
            target = resolved?.target || null;
            if (resolved?.done && target) return target;
            const delayedFirst = resolved?.resolution?.first;
            const delayedLast = resolved?.resolution?.last;
            if (delayedFirst !== nextFirst || delayedLast !== nextLast) {
              previousFirst = delayedFirst;
              previousLast = delayedLast;
              continue;
            }
          }
          previousFirst = nextFirst;
          previousLast = nextLast;
          if (!changedScroll && !changedRange) break;
          if (resolved?.resolution) {
            if (travelDirection > 0 && resolved.resolution.first > index) {
              if (preferExact) break;
              break;
            }
            if (travelDirection < 0 && resolved.resolution.last < index) {
              if (preferExact) break;
              break;
            }
          }
        }
      }
    }
    if (shouldResolveFloor) {
      const floorTarget = mountedFloorTargetForIndex(index);
      if (floorTarget && floorTarget.order - 1 <= index) return floorTarget;
      const resolution = mountedResolutionForIndex(index);
      if (resolution?.ceiling) return resolution.ceiling;
      return floorTarget || null;
    }
    target = mountedTargetForIndex(index, direction);
    return isExactKnownTarget(target) ? target : null;
  }

  function lastKnownIndex() {
    const list = anchors();
    if (!list.length) return 0;
    const indexedKeys = Object.keys(state.anchorIdByIndex).map(Number).filter((index) => Number.isSafeInteger(index));
    return Math.max(...list.map((item) => item.order - 1), ...indexedKeys, state.anchorOrder.length - 1, 0);
  }

  async function jumpToIndex(index, options = {}) {
    const list = anchors();
    if (!list.length) return { ok: false, error: "no transcript anchors" };
    const indexedKeys = Object.keys(state.anchorIdByIndex).map(Number).filter((key) => Number.isSafeInteger(key));
    const maxIndex = Math.max(...list.map((item) => item.order - 1), ...indexedKeys, state.anchorOrder.length - 1, 0);
    const clamped = Math.max(0, Math.min(maxIndex, index));
    const target = options.resolveHidden === "bottom-floor-mounted"
      ? mountedBottomFloorTargetForIndex(clamped)
      : options.resolveHidden === "floor-mounted"
        ? mountedFloorTargetForIndex(clamped)
        : await mountTargetForIndex(clamped, options.direction || 0, options);
    if (!target) return { ok: false, error: "target transcript anchor not mounted" };
    const targetIndex = target.order - 1;
    setCurrent(target.anchorId, options.source || "adapter", clamped);
    return scrollToAnchor(target.anchorId, {
      behavior: options.behavior || "auto",
      block: options.block || "center",
      indexHint: targetIndex,
      skipScrollIfVisible: options.skipScrollIfResolvedFloor && targetIndex !== clamped
    });
  }

  function jumpRelativeFast(delta) {
    if (!hasAppServerOrder()) return jumpRelativeMounted(delta);
    const startIndex = currentIndex();
    const targetIndex = startIndex + delta;
    const lastIndex = lastKnownIndex();
    if (targetIndex < 0 || targetIndex > lastIndex) {
      state.lastRelativeDebug = {
        delta,
        path: "edge",
        startIndex,
        targetIndex,
        lastIndex
      };
      return {
        ok: true,
        noop: true,
        edge: delta < 0 ? "top" : "bottom",
        anchorId: state.currentAnchorId
      };
    }
    const targetId = state.anchorOrder[targetIndex] || state.anchorIdByIndex[targetIndex] || null;
    const mounted = anchors().sort((a, b) => a.order - b.order);
    const target = targetId
      ? mounted.find((item) => item.anchorId === targetId)
      : mounted.find((item) => item.order - 1 === targetIndex);
    state.lastRelativeDebug = {
      delta,
      path: "fast",
      startIndex,
      targetIndex,
      target: target ? { order: target.order, anchorId: target.anchorId } : null,
      mounted: mounted.map((item) => item.order)
    };
    if (!target || !findAnchor(target.anchorId)) {
      return jumpToIndex(targetIndex, {
        block: "start",
        direction: delta,
        behavior: "auto",
        approximate: true,
        preferExact: true,
        resolveMissing: "floor-on-overshoot",
        skipScrollIfResolvedFloor: true
      });
    }
    setCurrent(target.anchorId, "adapter", target.order - 1);
    return scrollToAnchor(target.anchorId, {
      behavior: "auto",
      block: "start",
      indexHint: target.order - 1
    });
  }

  function jumpToNumberIndex(requested) {
    const mountedRange = mountedIndexRange();
    const knownTarget = Boolean(state.anchorIdByIndex[requested] || state.anchorOrder[requested]);
    if (mountedRange && requested >= mountedRange.first && requested <= mountedRange.last) {
      const exact = mountedRange.mounted.find((item) => item.order - 1 === requested);
      if (!exact && knownTarget) {
        return jumpToIndex(requested, {
          block: "start",
          behavior: "auto",
          direction: requested < currentIndex() ? -1 : 1,
          approximate: true,
          preferExact: true,
          resolveMissing: "floor-on-overshoot",
          skipScrollIfResolvedFloor: true
        });
      }
      const target = mountedFloorTargetForIndex(requested);
      if (!target) return { ok: false, error: "target transcript anchor not mounted" };
      setCurrent(target.anchorId, "adapter", target.order - 1);
      return scrollToAnchor(target.anchorId, {
        block: "start",
        behavior: "auto",
        indexHint: target.order - 1,
        skipScrollIfVisible: !exact
      });
    }
    if (mountedRange) {
      return jumpToIndex(requested, {
        block: "start",
        behavior: "auto",
        direction: requested < mountedRange.first ? -1 : 1,
        approximate: true,
        preferExact: knownTarget,
        resolveMissing: "floor-on-overshoot",
        skipScrollIfResolvedFloor: true
      });
    }
    return jumpToIndex(requested, {
      block: "start",
      behavior: "auto",
      approximate: true,
      preferExact: knownTarget,
      resolveMissing: "floor-on-overshoot",
      skipScrollIfResolvedFloor: true
    });
  }

  function jumpToCountOrLast(prefix = state.countPrefix) {
    if (prefix) {
      const displayNumber = Number(prefix);
      const requested = displayNumber - 1;
      if (requested > lastKnownIndex()) {
        return jumpToBottom();
      }
      return jumpToNumberIndex(requested);
    }
    return jumpToBottom();
  }

  async function jumpToBottom() {
    const targetIndex = lastKnownIndex();
    let best = mountedBottomFloorTargetForIndex(targetIndex);
    const debug = {
      targetIndex,
      initialBest: best ? { order: best.order, anchorId: best.anchorId } : null,
      roots: []
    };
    state.lastBottomJump = debug;
    if (best && best.order - 1 >= targetIndex - 3) {
      const result = jumpToMountedBottomTarget(best);
      await delay(160);
      anchors();
      debug.initialBestVisible = isAnchorViewportVisible(best.anchorId);
      if (debug.initialBestVisible) {
        debug.result = "initial-best";
        return result;
      }
    }
    for (const root of bottomScrollRoots()) {
      const range = scrollRootRange(root);
      const before = scrollTopOf(root);
      for (const top of [...new Set([range.max, range.min])]) {
        scrollRootTo(root, top);
        await delay(140);
        anchors();
        const candidate = mountedBottomFloorTargetForIndex(targetIndex);
        const visible = candidate ? isAnchorViewportVisible(candidate.anchorId) : false;
        debug.roots.push({
          root: describeScrollRoot(root),
          before,
          requestedTop: top,
          after: scrollTopOf(root),
          range,
          mounted: anchors().map((item) => item.order),
          candidate: candidate ? { order: candidate.order, anchorId: candidate.anchorId, visible } : null
        });
        if (candidate && (!best || candidate.order > best.order)) best = candidate;
        if (candidate && candidate.order - 1 >= targetIndex - 8) {
          const result = jumpToMountedBottomTarget(candidate);
          await delay(160);
          if (isAnchorViewportVisible(candidate.anchorId)) {
            debug.result = "root-candidate";
            return result;
          }
        }
      }
    }
    const result = await jumpToIndex(targetIndex, {
      block: "start",
      direction: 1,
      behavior: "auto",
      resolveMissing: "bottom-floor-on-end"
    });
    if (result?.ok || !best || best.order - 1 < targetIndex - 8) {
      debug.result = result?.ok ? "jump-index" : "failed";
      debug.error = result?.error || null;
      return result;
    }
    if (!findAnchor(best.anchorId)) {
      debug.result = "best-unmounted";
      debug.error = result?.error || null;
      return result;
    }
    debug.result = "best-fallback";
    return jumpToMountedBottomTarget(best);
  }

  function describeScrollRoot(root) {
    if (!root) return null;
    if (isDocumentScrollRoot(root)) return "document";
    const el = root;
    return [
      el.tagName?.toLowerCase() || "node",
      el.id ? `#${el.id}` : "",
      el.className && typeof el.className === "string" ? `.${el.className.split(/\s+/).slice(0, 3).join(".")}` : ""
    ].join("");
  }

  function jumpToMountedBottomTarget(target) {
    setCurrent(target.anchorId, "adapter", target.order - 1);
    return scrollToAnchor(target.anchorId, {
      behavior: "auto",
      block: "end",
      indexHint: target.order - 1
    });
  }

  function alignCurrent(block) {
    const list = anchors();
    if (!list.length) return { ok: false, error: "no transcript anchors" };
    const index = currentIndex();
    const target = mountedTargetForIndex(index);
    if (!target) return { ok: false, error: "target transcript anchor not mounted" };
    return scrollToAnchor(target.anchorId, {
      behavior: "auto",
      block,
      indexHint: target.order - 1
    });
  }

  function jumpRole(role, direction) {
    const list = anchors();
    const start = currentIndex();
    const candidates = direction < 0 ? [...list].reverse() : list;
    for (const item of candidates) {
      const index = item.order - 1;
      if ((direction < 0 ? index < start : index > start) && item.inferredRole === role) {
        return jumpToIndex(index, { direction, block: "start", behavior: "auto" });
      }
    }
    return { ok: false, error: `${role} anchor not found` };
  }

  function scrollToAnchor(id, options = {}) {
    ensureAnnotations();
    const el = findAnchor(id);
    if (!el) return { ok: false, error: "anchor not found" };
    setCurrent(id, "adapter", options.indexHint);
    if (options.skipScrollIfVisible && isAnchorViewportVisible(id)) {
      highlightAnchor(id, { durationMs: 900 });
      return { ok: true, anchorId: id, skippedScroll: true };
    }
    scrollAnchorIntoView(el, id, options);
    ensureAnnotations();
    setTimeout(() => ensureAnnotations(), 120);
    highlightAnchor(id, { durationMs: 900 });
    return { ok: true, anchorId: id };
  }

  function isAnchorViewportVisible(id) {
    const el = findAnchor(id);
    if (!(el instanceof HTMLElement)) return false;
    const target = markerForAnchor(el, id);
    const rect = target?.getBoundingClientRect?.() || el.getBoundingClientRect();
    return rect.bottom >= topVisibleInset() &&
      rect.top <= viewportSafeBottom() &&
      rect.right >= 0 &&
      rect.left <= window.innerWidth;
  }

  function blockForAnchorVisibility(id, fallback = "start") {
    const el = findAnchor(id);
    if (!(el instanceof HTMLElement)) return fallback;
    const target = markerForAnchor(el, id);
    const rect = target?.getBoundingClientRect?.() || el.getBoundingClientRect();
    if (rect.bottom > viewportSafeBottom()) return "end";
    if (rect.top < topVisibleInset()) return "start";
    return fallback;
  }

  function highlightAnchor(id, options = {}) {
    ensureStyle();
    for (const el of document.querySelectorAll(`.${HIGHLIGHT_CLASS}`)) el.classList.remove(HIGHLIGHT_CLASS);
    const el = findAnchor(id);
    if (!el) return { ok: false, error: "anchor not found" };
    el.classList.add(HIGHLIGHT_CLASS);
    setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), options.durationMs || 1500);
    return { ok: true, anchorId: id };
  }

  function setAnnotations(annotations = []) {
    ensureAnnotations();
    let applied = 0;
    for (const annotation of annotations) {
      const el = findAnchor(annotation.anchorId);
      const marker = annotation.markers?.[0];
      const label = el?.querySelector?.(`.${ANNOTATION_CLASS}[data-anchor-id="${cssEscape(annotation.anchorId)}"]`);
      if (label && marker) {
        label.textContent = marker.glyph || label.textContent;
        label.title = marker.label || label.title;
        applied += 1;
      }
    }
    return { ok: true, applied };
  }

  function setTranscriptOrder(anchorIds = [], metadata = {}) {
    const ids = Array.from(new Set(anchorIds.filter(Boolean)));
    if (!ids.length) return { ok: false, error: "empty transcript order" };
    state.anchorOrder = ids;
    rebuildAnchorIndex();
    state.anchorOrderFrozen = true;
    state.transcriptOrderSource = metadata.source || "external";
    ensureAnnotations();
    return { ok: true, count: ids.length, source: state.transcriptOrderSource };
  }

  let annotationRefreshTimer = null;

  function scheduleAnnotationRefresh() {
    if (annotationRefreshTimer) return;
    annotationRefreshTimer = setTimeout(() => {
      annotationRefreshTimer = null;
      if (!state.anchorOrderFrozen) {
        if (!state.indexingPromise) primeAnchorOrder().catch(() => {});
        return;
      }
      ensureAnnotations();
    }, 80);
  }

  function visibleInteractiveElements() {
    return Array.from(document.querySelectorAll("button, [role='button'], input, textarea, a"))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 &&
          rect.bottom > 0 && rect.top < window.innerHeight &&
          rect.right > 0 && rect.left < window.innerWidth;
      });
  }

  function textOf(el) {
    return (el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function browserUrlInput() {
    return Array.from(document.querySelectorAll("input")).find((input) => /url|address/i.test(input.placeholder || ""));
  }

  function nativeBrowserButton() {
    return visibleInteractiveElements()
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: textOf(el) }))
      .filter(({ rect }) => rect.left > window.innerWidth * 0.45)
      .find(({ text }) => /⌘T/.test(text) || /^Brow/i.test(text))?.el || null;
  }

  function toggleSidePanelButton() {
    return visibleInteractiveElements()
      .filter((el) => /toggle side panel/i.test(el.getAttribute("aria-label") || el.getAttribute("title") || ""))
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0] || null;
  }

  function localServerButton() {
    return visibleInteractiveElements()
      .find((el) => /vim nav|codex vim|localhost|127\.0\.0\.1/i.test(el.getAttribute("aria-label") || textOf(el)));
  }

  function panelDebug(extra = {}) {
    const rightControls = visibleInteractiveElements()
      .filter((el) => el.getBoundingClientRect().left > window.innerWidth * 0.45)
      .map((el) => ({
        tag: el.tagName,
        role: el.getAttribute("role") || null,
        text: textOf(el).slice(0, 80),
        aria: el.getAttribute("aria-label") || null,
        title: el.getAttribute("title") || null,
        placeholder: el.getAttribute("placeholder") || null,
        left: Math.round(el.getBoundingClientRect().left),
        top: Math.round(el.getBoundingClientRect().top)
      }))
      .slice(-24);
    return {
      hasUrlInput: Boolean(browserUrlInput()),
      hasBrowserButton: Boolean(nativeBrowserButton()),
      hasSideToggle: Boolean(toggleSidePanelButton()),
      frameSrcs: Array.from(document.querySelectorAll("webview, iframe")).map((el) => el.getAttribute("src") || ""),
      rightControls,
      ...extra
    };
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clankerbendRuntime() {
    if (window[RUNTIME_KEY]?.registerApp) return window[RUNTIME_KEY];
    const runtime = {
      protocolVersion: null,
      hostUrl: null,
      apps: {},
      registerApp(app) {
        if (!app?.appId) throw new Error("ClankerBend appId is required");
        const current = this.apps[app.appId] || {};
        const currentVersion = Number(current.bridge?.version);
        const nextVersion = Number(app.bridge?.version);
        if (
          current.bridge &&
          app.bridge &&
          Number.isFinite(currentVersion) &&
          Number.isFinite(nextVersion) &&
          nextVersion < currentVersion
        ) {
          throw new Error("ClankerBend app bridge version regressed for " + app.appId);
        }
        const slot = {
          ...current,
          ...app,
          appId: app.appId,
          entryUrl: app.entryUrl || current.entryUrl || null,
          capabilities: app.capabilities || current.capabilities || {},
          injectedAt: app.injectedAt || current.injectedAt || new Date().toISOString()
        };
        this.apps[app.appId] = slot;
        return slot;
      },
      getApp(appId) {
        return this.apps[appId] || null;
      },
      getBridge(appId) {
        return this.getApp(appId)?.bridge || null;
      },
      getEntryUrl(appId) {
        return this.getApp(appId)?.entryUrl || null;
      }
    };
    window[RUNTIME_KEY] = runtime;
    return runtime;
  }

  function enqueueHostEvent(event) {
    state.hostEvents.push({
      eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      requestedAt: new Date().toISOString(),
      ...event
    });
  }

  function drainHostEvents() {
    const events = state.hostEvents;
    state.hostEvents = [];
    return events;
  }

  function applyHostState(hostState) {
    state.hostState = hostState || null;
    settleAccountUiStatus();
    renderCodexAccountSwitcher();
    renderSelectionMenu();
    renderOverlay();
    renderComposerContextChips();
    maskSubmittedComposerContexts();
    installComposerSubmitInterceptor();
    return { ok: true };
  }

  function settleAccountUiStatus() {
    if (state.accountUiStatus !== "Saving default...") return;
    if (state.hostState?.codexAccounts?.switching) return;
    state.accountUiStatus = "Default saved";
    setTimeout(() => {
      if (state.accountUiStatus !== "Default saved") return;
      state.accountUiStatus = "";
      renderCodexAccountSwitcher();
    }, 1400);
  }

  function codexAccountsState() {
    return state.hostState?.codexAccounts || null;
  }

  function visibleElement(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (!el.isConnected) return false;
    if (isHostUiElement(el)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function normalizedText(el) {
    return String(el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findLogoutMenuItem() {
    const candidates = Array.from(document.querySelectorAll("button,a,[role='menuitem'],[role='button']"))
      .filter(visibleElement)
      .map((el) => {
        const text = normalizedText(el);
        const label = [text, el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean).join(" ");
        return { el, label };
      })
      .filter((candidate) => /\b(log\s*out|logout|sign\s*out)\b/i.test(candidate.label));
    return candidates
      .map((candidate) => candidate.el.closest?.("button,a,[role='menuitem']") || candidate.el)
      .find((el) => el instanceof HTMLElement && visibleElement(el)) || null;
  }

  function accountMenuInsertionParent(logoutItem) {
    if (!(logoutItem instanceof HTMLElement)) return null;
    for (let node = logoutItem.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (isHostUiElement(node)) return null;
      const rect = node.getBoundingClientRect();
      if (rect.width < 150 || rect.width > 520 || rect.height < 40 || rect.height > window.innerHeight * 0.9) continue;
      if (node.contains(logoutItem)) return node;
    }
    return logoutItem.parentElement;
  }

  function accountMenuInsertionReference(parent, logoutItem) {
    if (!(parent instanceof HTMLElement) || !(logoutItem instanceof HTMLElement)) return null;
    let reference = logoutItem;
    while (reference?.parentElement && reference.parentElement !== parent) {
      reference = reference.parentElement;
    }
    return reference?.parentElement === parent ? reference : null;
  }

  function accountUiSignature(accountsState) {
    const accounts = accountsState?.accounts || [];
    return JSON.stringify({
      active: accountsState?.activeAccountId || null,
      def: accountsState?.clankerbendDefaultAccountId || null,
      switching: Boolean(accountsState?.switching),
      status: state.accountUiStatus,
      addOpen: state.accountAddOpen,
      manageOpen: state.accountManageOpen,
      pendingAdopt: state.accountPendingAdoptId,
      pendingDelete: state.accountPendingDeleteId,
      accounts: accounts.map((account) => [
        account.id,
        account.kind,
        account.label,
        account.codexHome,
        account.auth?.authJson ? 1 : 0,
        account.backup ? 1 : 0
      ])
    });
  }

  function renderCodexAccountSwitcher() {
    const accountsState = codexAccountsState();
    const logoutItem = findLogoutMenuItem();
    if (!accountsState?.available || !logoutItem) {
      document.getElementById(ACCOUNT_SWITCHER_ID)?.remove();
      return;
    }

    const parent = accountMenuInsertionParent(logoutItem);
    if (!(parent instanceof HTMLElement)) return;
    const reference = accountMenuInsertionReference(parent, logoutItem);
    if (!(reference instanceof HTMLElement)) return;
    let ui = document.getElementById(ACCOUNT_SWITCHER_ID);
    if (ui && ui.parentElement !== parent) {
      ui.remove();
      ui = null;
    }
    if (!ui) {
      ui = document.createElement("div");
      ui.id = ACCOUNT_SWITCHER_ID;
      ui.className = HOST_UI_CLASS;
      stopNativeMenuPropagation(ui);
      parent.insertBefore(ui, reference);
    } else if (ui.nextElementSibling !== reference) {
      parent.insertBefore(ui, reference);
    }

    const signature = accountUiSignature(accountsState);
    if (ui.dataset.signature === signature) return;
    ui.dataset.signature = signature;
    ui.replaceChildren();

    const head = document.createElement("div");
    head.className = "clankerbend-account-head";
    const title = document.createElement("div");
    title.className = "clankerbend-account-title";
    title.textContent = "ClankerID";
    const status = document.createElement("div");
    status.className = "clankerbend-account-status";
    status.textContent = state.accountUiStatus || (accountsState.switching ? "Switching..." : `${accountsState.accounts?.length || 0}/${accountsState.maxAccounts || 20}`);
    head.append(title, status);
    ui.appendChild(head);

    if (state.accountManageOpen) {
      ui.appendChild(renderCodexAccountManage(accountsState));
    } else {
      const list = document.createElement("div");
      list.className = "clankerbend-account-list";
      for (const account of accountsState.accounts || []) {
        list.appendChild(renderCodexAccountRow(account, accountsState));
      }
      ui.appendChild(list);
    }

    const actions = document.createElement("div");
    actions.className = "clankerbend-account-actions";
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add account";
    add.disabled = Boolean(accountsState.switching) || (accountsState.accounts?.length || 0) >= (accountsState.maxAccounts || 20);
    bindInjectedActivation(add, () => {
      state.accountAddOpen = true;
      state.accountUiStatus = "";
      renderCodexAccountSwitcher();
      setTimeout(() => {
        document.querySelector(`#${ACCOUNT_SWITCHER_ID} input[data-clankerbend-account-label]`)?.focus?.({ preventScroll: true });
      }, 0);
    });
    const manage = document.createElement("button");
    manage.type = "button";
    manage.textContent = state.accountManageOpen ? "Done" : "Manage";
    bindInjectedActivation(manage, () => {
      state.accountManageOpen = !state.accountManageOpen;
      state.accountPendingAdoptId = null;
      state.accountPendingDeleteId = null;
      state.accountUiStatus = "";
      renderCodexAccountSwitcher();
    });
    actions.append(add, manage);
    ui.appendChild(actions);
    if (state.accountAddOpen) ui.appendChild(renderCodexAccountAddForm(accountsState));
  }

  function renderCodexAccountAddForm(accountsState) {
    const form = document.createElement("div");
    form.className = "clankerbend-account-add-form";

    const input = document.createElement("input");
    input.type = "text";
    input.dataset.clankerbendAccountLabel = "true";
    input.placeholder = "Account label";
    input.value = state.accountAddLabel || "";
    input.autocomplete = "off";
    input.spellcheck = false;
    const stopInputEvent = (event) => {
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };
    input.addEventListener("pointerdown", stopInputEvent, true);
    input.addEventListener("mousedown", stopInputEvent, true);
    input.addEventListener("click", stopInputEvent, true);
    input.addEventListener("input", () => {
      state.accountAddLabel = input.value;
    });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      if (event.key === "Enter") {
        event.preventDefault();
        submitCodexAccountAdd(input.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelCodexAccountAdd();
      }
    }, true);

    const buttons = document.createElement("div");
    buttons.className = "clankerbend-account-add-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    bindInjectedActivation(cancel, cancelCodexAccountAdd);
    const create = document.createElement("button");
    create.type = "button";
    create.textContent = "Create";
    create.disabled = Boolean(accountsState.switching);
    bindInjectedActivation(create, () => submitCodexAccountAdd(input.value));
    buttons.append(cancel, create);
    form.append(input, buttons);
    return form;
  }

  function cancelCodexAccountAdd() {
    state.accountAddOpen = false;
    state.accountAddLabel = "";
    state.accountUiStatus = "";
    renderCodexAccountSwitcher();
  }

  function submitCodexAccountAdd(rawLabel) {
    const label = String(rawLabel || "").trim();
    if (!label) {
      state.accountUiStatus = "Label required";
      renderCodexAccountSwitcher();
      setTimeout(() => {
        if (state.accountUiStatus !== "Label required") return;
        state.accountUiStatus = "";
        renderCodexAccountSwitcher();
      }, 1400);
      return;
    }
    state.accountAddOpen = false;
    state.accountAddLabel = "";
    state.accountUiStatus = "Creating...";
    renderCodexAccountSwitcher();
    enqueueHostEvent({ kind: "codexAccountCreateAndSwitch", label });
  }

  function renderCodexAccountManage(accountsState) {
    const wrap = document.createElement("div");
    wrap.className = "clankerbend-account-manage";
    const head = document.createElement("div");
    head.className = "clankerbend-account-manage-head";
    const title = document.createElement("strong");
    title.textContent = "Manage profiles";
    const count = document.createElement("span");
    const managed = (accountsState.accounts || []).filter((account) => account.kind === "managed");
    count.textContent = `${managed.length} managed`;
    head.append(title, count);
    wrap.appendChild(head);
    const list = document.createElement("div");
    list.className = "clankerbend-account-manage-list";
    if (!managed.length) {
      const row = document.createElement("div");
      row.className = "clankerbend-account-manage-row";
      const title = document.createElement("div");
      title.className = "clankerbend-account-manage-title";
      const strong = document.createElement("strong");
      strong.textContent = "No managed accounts";
      const hint = document.createElement("span");
      hint.textContent = "Create one with Add account.";
      title.append(strong, hint);
      row.appendChild(title);
      list.appendChild(row);
      wrap.appendChild(list);
      return wrap;
    }
    for (const account of managed) list.appendChild(renderCodexAccountManageRow(account, accountsState));
    wrap.appendChild(list);
    return wrap;
  }

  function renderCodexAccountManageRow(account, accountsState) {
    const row = document.createElement("div");
    row.className = "clankerbend-account-manage-row";
    row.title = accountCodexHomeTitle(account);
    const title = document.createElement("div");
    title.className = "clankerbend-account-manage-title";
    const strong = document.createElement("strong");
    strong.textContent = account.label || account.id;
    const hint = document.createElement("span");
    const pendingAdopt = state.accountPendingAdoptId === account.id;
    const pendingDelete = state.accountPendingDeleteId === account.id;
    hint.textContent = pendingAdopt
      ? "Replace ~/.codex with this profile; current primary is backed up."
      : pendingDelete
        ? "Hide this profile and move its files to archive storage."
        : [account.auth?.authJson ? "signed in" : "not signed in", account.backup ? "backup" : ""].filter(Boolean).join(" · ");
    title.append(strong, hint);

    const actions = document.createElement("div");
    actions.className = "clankerbend-account-manage-actions";
    const adopt = document.createElement("button");
    adopt.type = "button";
    adopt.textContent = pendingAdopt ? "Replace ~/.codex" : "Make primary";
    adopt.title = "Make this the primary Codex home";
    adopt.disabled = Boolean(accountsState.switching);
    bindInjectedActivation(adopt, () => {
      if (!pendingAdopt) {
        state.accountPendingAdoptId = account.id;
        state.accountPendingDeleteId = null;
        state.accountUiStatus = "";
        renderCodexAccountSwitcher();
        return;
      }
      state.accountUiStatus = "Making primary...";
      state.accountPendingAdoptId = null;
      renderCodexAccountSwitcher();
      enqueueHostEvent({ kind: "codexAccountAdoptAsPrimary", accountId: account.id });
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = pendingDelete ? "Archive profile" : "Archive";
    remove.title = "Archive this managed profile";
    remove.disabled = Boolean(accountsState.switching) || account.id === accountsState.activeAccountId;
    bindInjectedActivation(remove, () => {
      if (!pendingDelete) {
        state.accountPendingDeleteId = account.id;
        state.accountPendingAdoptId = null;
        state.accountUiStatus = "";
        renderCodexAccountSwitcher();
        return;
      }
      state.accountUiStatus = "Archiving...";
      state.accountPendingDeleteId = null;
      renderCodexAccountSwitcher();
      enqueueHostEvent({ kind: "codexAccountDelete", accountId: account.id });
    });

    actions.append(adopt, remove);
    row.append(title, actions);
    return row;
  }

  function stopNativeMenuPropagation(el) {
    const stop = (event) => {
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };
    el.addEventListener("pointerdown", stop);
    el.addEventListener("mousedown", stop);
    el.addEventListener("touchstart", stop, { passive: false });
    el.addEventListener("click", stop);
  }

  function bindInjectedActivation(button, handler) {
    let lastRunAt = 0;
    const run = (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      if (button.disabled) return;
      const now = Date.now();
      if (now - lastRunAt < 450) return;
      lastRunAt = now;
      handler(event);
    };
    button.addEventListener("pointerdown", run, true);
    button.addEventListener("mousedown", run, true);
    button.addEventListener("touchstart", run, { capture: true, passive: false });
    button.addEventListener("click", run, true);
  }

  function renderCodexAccountRow(account, accountsState) {
    const row = document.createElement("div");
    row.className = `clankerbend-account-row${account.id === accountsState.activeAccountId ? " is-active" : ""}`;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "clankerbend-account-main";
    main.disabled = Boolean(accountsState.switching) || account.id === accountsState.activeAccountId;
    main.title = [
      account.id === accountsState.activeAccountId ? "Current Codex account profile" : `Switch to ${account.label || account.id}`,
      accountCodexHomeTitle(account)
    ].filter(Boolean).join("\n");
    bindInjectedActivation(main, () => {
      if (account.id === accountsState.activeAccountId) return;
      state.accountUiStatus = "Switching...";
      renderCodexAccountSwitcher();
      enqueueHostEvent({ kind: "codexAccountSwitch", accountId: account.id });
    });

    const label = document.createElement("span");
    label.className = "clankerbend-account-label";
    label.textContent = account.label || account.id;
    const meta = document.createElement("span");
    meta.className = "clankerbend-account-meta";
    meta.textContent = [
      account.kind,
      account.id === accountsState.clankerbendDefaultAccountId ? "default" : "",
      account.auth?.authJson ? "signed in" : "not signed in"
    ].filter(Boolean).join(" · ");
    main.append(label, meta);

    const def = document.createElement("button");
    def.type = "button";
    def.className = "clankerbend-account-icon";
    def.textContent = account.id === accountsState.clankerbendDefaultAccountId ? "✓" : "☆";
    def.setAttribute("aria-label", account.id === accountsState.clankerbendDefaultAccountId ? "Launches by default" : "Launch by default");
    def.title = [
      account.id === accountsState.clankerbendDefaultAccountId ? "Launches by default" : "Launch by default",
      accountCodexHomeTitle(account)
    ].filter(Boolean).join("\n");
    def.disabled = Boolean(accountsState.switching) || account.id === accountsState.clankerbendDefaultAccountId;
    bindInjectedActivation(def, () => {
      state.accountUiStatus = "Saving default...";
      renderCodexAccountSwitcher();
      enqueueHostEvent({ kind: "codexAccountSetDefault", accountId: account.id });
    });

    row.append(main, def);
    return row;
  }

  function accountCodexHomeTitle(account) {
    return account?.codexHome ? `CODEX_HOME: ${account.codexHome}` : "";
  }

  function hostSelectionActions() {
    return (state.hostState?.selectionActions || [])
      .filter((action) => action?.enabled !== false && action.appliesTo === "text-selection");
  }

  function ensureHostElement(id) {
    ensureStyle();
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.className = HOST_UI_CLASS;
      document.documentElement.appendChild(el);
    }
    return el;
  }

  function transcriptAnchorForNode(node) {
    for (let el = node instanceof Element ? node : node?.parentElement; el; el = el.parentElement) {
      if (el.matches?.(SELECTOR)) return el;
      const nested = el.querySelector?.(SELECTOR);
      if (nested?.contains?.(node)) return nested;
    }
    return null;
  }

  function selectionRangeFromDom() {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const text = String(selection.toString() || "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    const anchorEl = transcriptAnchorForNode(range.commonAncestorContainer);
    const anchorIdValue = anchorId(anchorEl);
    if (!anchorEl || !anchorIdValue) return null;
    const preview = previewText(anchorEl);
    const index = preview.indexOf(text);
    return {
      selectionId: `sel_${Date.now()}`,
      source: "transcript",
      appId: state.hostState?.panel?.activeAppId || VIM_NAV_APP_ID,
      anchorId: anchorIdValue,
      quote: text,
      range: {
        anchorId: anchorIdValue,
        text,
        quote: text,
        prefix: index >= 0 ? preview.slice(Math.max(0, index - 80), index) : "",
        suffix: index >= 0 ? preview.slice(index + text.length, index + text.length + 80) : "",
        startOffset: index >= 0 ? index : undefined,
        endOffset: index >= 0 ? index + text.length : undefined,
        fingerprint: `${anchorIdValue}:${text}`
      },
      selectedAt: new Date().toISOString(),
      rect: rectFromRange(range)
    };
  }

  function rectFromRange(range) {
    const rect = range.getBoundingClientRect();
    if (rect.width || rect.height) return rect;
    const fallback = range.startContainer?.parentElement?.getBoundingClientRect?.();
    return fallback || { left: window.innerWidth / 2, top: window.innerHeight / 2, right: window.innerWidth / 2, bottom: window.innerHeight / 2, width: 0, height: 0 };
  }

  function updateTextSelectionFromDom() {
    const next = selectionRangeFromDom();
    if (!next) return false;
    state.activeTextSelection = next;
    state.selection = {
      selectionId: next.selectionId,
      source: "transcript",
      appId: next.appId,
      anchorId: next.anchorId,
      quote: next.quote,
      range: next.range,
      selectedAt: next.selectedAt
    };
    setCurrent(next.anchorId, "transcript");
    enqueueHostEvent({
      kind: "selection",
      selection: state.selection
    });
    renderSelectionMenu();
    return true;
  }

  function hideSelectionMenu() {
    const menu = document.getElementById(SELECTION_MENU_ID);
    menu?.remove();
    document.querySelectorAll("[data-clankerbend-native-selection-action='true']").forEach((node) => node.remove());
  }

  function selectionPayloadForAction(action, selection) {
    return {
      ...(action.payload || {}),
      selection: {
        selectionId: selection.selectionId,
        source: "transcript",
        appId: action.appId,
        anchorId: selection.anchorId,
        quote: selection.quote,
        range: selection.range,
        rect: plainRect(selection.rect),
        selectedAt: selection.selectedAt
      }
    };
  }

  function plainRect(rect) {
    if (!rect) return null;
    return {
      left: Number(rect.left || 0),
      top: Number(rect.top || 0),
      right: Number(rect.right || 0),
      bottom: Number(rect.bottom || 0),
      width: Number(rect.width || 0),
      height: Number(rect.height || 0)
    };
  }

  function triggerSelectionAction(action, selection) {
    enqueueHostEvent({
      kind: "appAction",
      appId: action.appId,
      type: action.type,
      payload: selectionPayloadForAction(action, selection)
    });
    hideSelectionMenu();
  }

  function nativeSelectionToolbar() {
    const candidates = Array.from(document.querySelectorAll("div,section,nav,menu,[role='toolbar'],[role='menu']"))
      .filter((el) => el instanceof HTMLElement && !isHostUiElement(el))
      .map((el) => {
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        const rect = el.getBoundingClientRect();
        const buttons = Array.from(el.querySelectorAll("button,[role='button']"));
        const hasNativeSelectionAction = buttons.some((button) => /\bAdd to chat\b/i.test(button.textContent || "")) ||
          buttons.some((button) => /\bAsk in side chat\b/i.test(button.textContent || "")) ||
          /\bAdd to chat\b/i.test(text) ||
          /\bAsk in side chat\b/i.test(text);
        const score = (/\bAdd to chat\b/i.test(text) ? 10 : 0) +
          (/\bAsk in side chat\b/i.test(text) ? 10 : 0) +
          (buttons.length >= 2 ? 2 : 0) +
          (rect.width > 160 && rect.height > 28 ? 2 : 0);
        return { el, text, rect, score, hasNativeSelectionAction };
      })
      .filter((candidate) =>
        candidate.hasNativeSelectionAction &&
        candidate.score >= 10 &&
        candidate.rect.width > 0 &&
        candidate.rect.height > 0 &&
        candidate.rect.width <= 640 &&
        candidate.rect.height <= 120 &&
        candidate.rect.top >= 0 &&
        candidate.rect.bottom <= window.innerHeight
      )
      .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top);
    return candidates[0]?.el || null;
  }

  function nativeSelectionToolbarButtons(toolbar) {
    return Array.from(toolbar?.querySelectorAll?.("button,[role='button']") || [])
      .filter((button) => /\bAdd to chat\b/i.test(button.textContent || "") || /\bAsk in side chat\b/i.test(button.textContent || ""));
  }

  function nativeSelectionInsertionTarget(toolbar) {
    const buttons = nativeSelectionToolbarButtons(toolbar);
    const lastButton = buttons[buttons.length - 1];
    const parent = lastButton?.parentElement;
    if (parent instanceof HTMLElement && toolbar.contains(parent)) return parent;
    return toolbar;
  }

  function extendNativeSelectionToolbar(toolbar, target) {
    if (!(toolbar instanceof HTMLElement)) return;
    toolbar.dataset.clankerbendNativeSelectionToolbar = "true";
    toolbar.style.setProperty("display", "inline-flex", "important");
    toolbar.style.setProperty("align-items", "center", "important");
    toolbar.style.setProperty("flex-wrap", "nowrap", "important");
    toolbar.style.setProperty("width", "max-content", "important");
    toolbar.style.setProperty("max-width", "calc(100vw - 24px)", "important");
    toolbar.style.setProperty("height", "auto", "important");
    toolbar.style.setProperty("overflow", "visible", "important");
    if (target instanceof HTMLElement) {
      target.style.setProperty("display", "inline-flex", "important");
      target.style.setProperty("align-items", "center", "important");
      target.style.setProperty("flex-wrap", "nowrap", "important");
      target.style.setProperty("width", "max-content", "important");
      target.style.setProperty("max-width", "calc(100vw - 24px)", "important");
    }
  }

  function nativeSelectionReferenceButton(toolbar) {
    const buttons = nativeSelectionToolbarButtons(toolbar);
    return buttons[buttons.length - 1] || null;
  }

  function nativeSelectionButtonLabel(action) {
    const label = action.label || action.type;
    if (normalizedActionLabel(label) === "add note") return "📝 Add note";
    return label;
  }

  function stylePropertyValue(style, property) {
    const direct = style?.getPropertyValue?.(property);
    if (direct) return direct;
    const camel = property.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    return style?.[property] || style?.[camel] || "";
  }

  function createNativeSelectionButton(action, selection, referenceButton = null) {
    const button = document.createElement("button");
    let activated = false;
    const activate = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (activated) return;
      activated = true;
      triggerSelectionAction(action, selection);
    };
    button.type = "button";
    button.dataset.clankerbendNativeSelectionAction = "true";
    button.textContent = nativeSelectionButtonLabel(action);
    button.title = action.label || action.type;
    button.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "gap:6px",
      "min-height:28px",
      "appearance:none",
      "border:0",
      "background:transparent",
      "color:inherit",
      "font:inherit",
      "padding:0 2px",
      "white-space:nowrap",
      "pointer-events:auto",
      "cursor:pointer"
    ].join(";");
    if (referenceButton instanceof HTMLElement) {
      const referenceStyle = getComputedStyle(referenceButton);
      for (const property of ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing"]) {
        const value = stylePropertyValue(referenceStyle, property);
        if (value) button.style.setProperty(property, value, "important");
      }
    }
    button.addEventListener("pointerdown", activate);
    button.addEventListener("mousedown", activate);
    button.addEventListener("click", activate);
    return button;
  }

  function normalizedActionLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function injectNativeSelectionActions(selection, actions) {
    const toolbar = nativeSelectionToolbar();
    if (!toolbar) return false;
    document.querySelectorAll("[data-clankerbend-native-selection-action='true']").forEach((node) => node.remove());
    const target = nativeSelectionInsertionTarget(toolbar);
    extendNativeSelectionToolbar(toolbar, target);
    const referenceButton = nativeSelectionReferenceButton(toolbar);
    const nativeLabels = new Set(
      Array.from(toolbar.querySelectorAll("button,[role='button']"))
        .map((button) => normalizedActionLabel(button.innerText || button.textContent))
        .filter(Boolean)
    );
    for (const action of actions) {
      if (nativeLabels.has(normalizedActionLabel(action.label || action.type))) continue;
      target.appendChild(createNativeSelectionButton(action, selection, referenceButton));
    }
    return true;
  }

  function renderSelectionMenu() {
    const menu = document.getElementById(SELECTION_MENU_ID);
    const selection = state.activeTextSelection;
    const actions = hostSelectionActions();
    if (!selection || !actions.length) {
      menu?.remove();
      document.querySelectorAll("[data-clankerbend-native-selection-action='true']").forEach((node) => node.remove());
      return;
    }
    if (injectNativeSelectionActions(selection, actions)) {
      menu?.remove();
      return;
    }
    menu?.remove();
  }

  function overlayAnchorRect(overlay) {
    if (overlay?.anchorRect) return overlay.anchorRect;
    if (state.activeTextSelection?.anchorId === overlay?.anchorId && state.activeTextSelection?.rect) return state.activeTextSelection.rect;
    const anchor = overlay?.anchorId ? findAnchor(overlay.anchorId) : null;
    return anchor?.getBoundingClientRect?.() || { left: window.innerWidth / 2 - 160, top: window.innerHeight / 2 - 80, right: window.innerWidth / 2 + 160, bottom: window.innerHeight / 2 + 80 };
  }

  function overlayRenderSignature(overlay) {
    if (!overlay) return "";
    return JSON.stringify({
      overlayId: overlay.overlayId || "",
      appId: overlay.appId || "",
      kind: overlay.kind || "form",
      title: overlay.title || "",
      anchorId: overlay.anchorId || "",
      fields: (overlay.fields || []).map((field) => ({
        fieldId: field.fieldId || "",
        kind: field.kind || "input",
        label: field.label || ""
      })),
      actions: (overlay.actions || []).map((action) => ({
        type: action.type || "",
        label: action.label || ""
      }))
    });
  }

  function overlayFieldValues(el) {
    return Object.fromEntries([...el.querySelectorAll("[data-clankerbend-field-id]")]
      .map((input) => [input.dataset.clankerbendFieldId, input.value || ""]));
  }

  function positionOverlay(el, overlay) {
    const rect = overlayAnchorRect(overlay);
    const margin = 12;
    const gap = 10;
    const overlayRect = el.getBoundingClientRect?.() || {};
    const overlayWidth = overlayRect.width || 340;
    const overlayHeight = overlayRect.height || 168;
    const safeTop = topVisibleInset() + margin;
    const safeBottom = viewportSafeBottom() - margin;
    const maxTop = Math.max(safeTop, safeBottom - overlayHeight);
    const belowTop = rect.bottom + gap;
    const aboveTop = rect.top - overlayHeight - gap;
    const top = belowTop <= maxTop
      ? belowTop
      : aboveTop >= safeTop
        ? aboveTop
        : Math.min(maxTop, Math.max(safeTop, belowTop));
    const left = Math.min(window.innerWidth - overlayWidth - margin, Math.max(margin, rect.left));
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }

  function focusOverlayField(field) {
    if (!field?.focus) return;
    try {
      field.focus({ preventScroll: true });
    } catch {
      field.focus();
    }
  }

  function renderOverlay() {
    const el = ensureHostElement(OVERLAY_ID);
    const overlay = state.hostState?.overlay;
    if (!overlay) {
      el.classList.remove("is-visible");
      el.replaceChildren();
      state.renderedOverlaySignature = null;
      return;
    }
    const signature = overlayRenderSignature(overlay);
    if (state.renderedOverlaySignature === signature && el.classList.contains("is-visible")) {
      positionOverlay(el, overlay);
      return;
    }
    const currentValues = overlayFieldValues(el);
    const activeFieldId = document.activeElement?.dataset?.clankerbendFieldId || null;
    const fields = (overlay.fields || []).map((field) => {
      const input = field.kind === "textarea" ? document.createElement("textarea") : document.createElement("input");
      input.name = field.fieldId;
      input.placeholder = field.label || field.fieldId;
      input.value = currentValues[field.fieldId] ?? field.value ?? "";
      input.dataset.clankerbendFieldId = field.fieldId;
      return input;
    });
    const titleText = String(overlay.title || "").trim();
    const firstFieldLabel = String(overlay.fields?.[0]?.label || overlay.fields?.[0]?.fieldId || "").trim();
    const title = titleText && titleText !== firstFieldLabel ? document.createElement("strong") : null;
    if (title) title.textContent = titleText;
    const actions = document.createElement("div");
    actions.className = "clankerbend-overlay-actions";
    for (const action of overlay.actions || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label || "Apply";
      button.className = action.type === "overlay.close" ? "clankerbend-overlay-secondary" : "clankerbend-overlay-primary";
      button.addEventListener("click", () => {
        if (action.type === "overlay.close") {
          enqueueHostEvent({
            kind: "overlayClose",
            overlayId: overlay.overlayId
          });
          return;
        }
        const values = Object.fromEntries([...el.querySelectorAll("[data-clankerbend-field-id]")]
          .map((input) => [input.dataset.clankerbendFieldId, input.value || ""]));
        enqueueHostEvent({
          kind: "appAction",
          appId: overlay.appId,
          type: action.type,
          payload: {
            ...(action.payload || {}),
            ...values,
            overlayId: overlay.overlayId
          }
        });
      });
      actions.appendChild(button);
    }
    el.replaceChildren(...(title ? [title] : []), ...fields, actions);
    state.renderedOverlaySignature = signature;
    el.classList.add("is-visible");
    positionOverlay(el, overlay);
    const activeField = activeFieldId
      ? [...el.querySelectorAll("[data-clankerbend-field-id]")].find((field) => field.dataset.clankerbendFieldId === activeFieldId)
      : null;
    const firstField = fields.find((field) => field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement);
    setTimeout(() => focusOverlayField(activeField || firstField), 0);
  }

  function composerCandidates() {
    const selectors = "textarea, input, [contenteditable='true'], [role='textbox']";
    return Array.from(document.querySelectorAll(selectors))
      .filter((el) => el instanceof HTMLElement && !isHostUiElement(el))
      .map((input) => {
        const inputRect = input.getBoundingClientRect();
        if (inputRect.width < 180 || inputRect.height < 16) return null;
        if (inputRect.bottom < window.innerHeight * 0.45) return null;
        if (inputRect.top > window.innerHeight || inputRect.bottom < 0) return null;
        if (inputRect.right < window.innerWidth * 0.35) return null;
        let anchor = input.parentElement instanceof HTMLElement ? input.parentElement : input;
        for (let node = input.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
          const rect = node.getBoundingClientRect();
          if (rect.width < inputRect.width || rect.height < inputRect.height) continue;
          if (rect.bottom < inputRect.bottom - 4 || rect.top > inputRect.top + 4) continue;
          if (rect.height > Math.max(260, inputRect.height + 180)) break;
          if (rect.top < inputRect.top - 180) break;
          anchor = node;
          if (node.matches?.("form")) break;
        }
        const rect = anchor.getBoundingClientRect();
        return { input, anchor, rect, inputRect };
      })
      .filter(Boolean)
      .sort((a, b) =>
        b.inputRect.bottom - a.inputRect.bottom ||
        b.inputRect.width - a.inputRect.width ||
        (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height)
      );
  }

  function composerAnchorElement() {
    const candidates = composerCandidates();
    return candidates[0]?.anchor || null;
  }

  function composerInputElement() {
    const candidates = composerCandidates();
    return candidates[0]?.input || null;
  }

  function positionComposerContextChips(el) {
    const margin = 12;
    const anchor = composerAnchorElement();
    const chipRect = el.getBoundingClientRect?.() || {};
    const chipHeight = chipRect.height || 32;
    if (!anchor) {
      if (el.parentElement !== document.documentElement) document.documentElement.appendChild(el);
      el.style.setProperty("position", "fixed", "important");
      el.style.left = "42px";
      el.style.right = "42px";
      el.style.top = "auto";
      el.style.bottom = "78px";
      el.style.maxWidth = "calc(100vw - 84px)";
      return;
    }
    if (el.parentElement !== anchor) anchor.appendChild(el);
    if (getComputedStyle(anchor).position === "static") anchor.style.position = "relative";
    const rect = anchor.getBoundingClientRect();
    const maxWidth = Math.max(160, Math.min(rect.width - 16, window.innerWidth - (margin * 2)));
    const top = rect.height >= chipHeight + 44 ? 8 : Math.max(-chipHeight - 8, margin - rect.top);
    el.style.setProperty("position", "absolute", "important");
    el.style.left = "8px";
    el.style.right = "auto";
    el.style.top = `${top}px`;
    el.style.bottom = "auto";
    el.style.maxWidth = `${maxWidth}px`;
  }

  function renderComposerContextChips() {
    const el = ensureHostElement(COMPOSER_CHIPS_ID);
    const items = activeComposerSubmitItems();
    if (!items.length) {
      el.classList.remove("is-visible");
      el.replaceChildren();
      return;
    }
    el.replaceChildren(...items.map((item) => {
      const chip = document.createElement("div");
      chip.className = "clankerbend-context-chip";
      const label = document.createElement("span");
      label.textContent = item.label || item.body || item.itemId;
      chip.title = item.body || item.label || item.itemId;
      chip.addEventListener("click", () => {
        if (item.kind === "runtime-file") return;
        enqueueHostEvent({
          kind: item.range ? "highlightRange" : "highlightAnchor",
          anchorId: item.anchorId,
          range: item.range
        });
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "x";
      remove.title = "Remove context";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        if (item.kind === "runtime-file") {
          enqueueHostEvent({ kind: "composerAttachmentRemove", path: item.path });
        } else {
          enqueueHostEvent({ kind: "composerContextRemove", itemId: item.itemId });
        }
      });
      chip.append(label, remove);
      return chip;
    }));
    el.classList.add("is-visible");
    positionComposerContextChips(el);
  }

  function activeComposerContextItems() {
    return (state.hostState?.composer?.contextItems || []).filter((item) => item?.status !== "resolved" && item?.status !== "sent");
  }

  function activeComposerAttachmentItems() {
    return (state.hostState?.composer?.attachments || [])
      .filter((item) => item?.status !== "sent" && item?.body)
      .map((item) => ({
        ...item,
        itemId: item.fileId || item.path,
        label: item.name || item.relativePath || item.path,
        body: item.body,
        kind: "runtime-file"
      }));
  }

  function activeComposerSubmitItems() {
    return [
      ...activeComposerContextItems().map((item) => ({ ...item, kind: item.kind || "context-item" })),
      ...activeComposerAttachmentItems()
    ];
  }

  function composerText(el) {
    if (!el) return "";
    return "value" in el ? String(el.value || "") : String(el.innerText || el.textContent || "");
  }

  function setComposerText(el, value) {
    if (!el) return false;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus?.();
    }
    if ("value" in el) {
      const setter = Object.getOwnPropertyDescriptor(el.constructor?.prototype || HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    return true;
  }

  function clankerbendSubmitPrompt(submission) {
    const lines = [
      `[[CLANKERBEND_CONTEXT:${submission.submissionId}]]`,
      "Use these ClankerBend sticky notes as context. Do not mention the marker."
    ];
    for (const [index, item] of submission.items.entries()) {
      const selected = item.range?.quote || item.range?.text || item.label || "";
      if (item.kind === "runtime-file") {
        lines.push(
          "",
          `${index + 1}. Attached file: ${selected}`,
          item.path ? `Path: ${item.path}` : "",
          "",
          item.body || selected
        );
      } else {
        lines.push(
          "",
          `${index + 1}. Highlighted: ${selected}`,
          `Note: ${item.body || selected}`
        );
      }
    }
    lines.push(
      `[[/CLANKERBEND_CONTEXT:${submission.submissionId}]]`,
      "",
      submission.userText || "Use the ClankerBend context above."
    );
    return lines.join("\n");
  }

  function submittedChipRow(submission) {
    const row = document.createElement("div");
    row.className = "clankerbend-submitted-context-row";
    row.style.cssText = [
      "display:flex",
      "flex-wrap:wrap",
      "gap:7px",
      "margin:0 0 7px 0"
    ].join(";");
    for (const item of submission.items) {
      const chip = document.createElement("span");
      chip.className = "clankerbend-context-chip";
      chip.textContent = item.label || item.body || item.itemId;
      chip.title = item.body || item.label || item.itemId;
      row.appendChild(chip);
    }
    return row;
  }

  function maskSubmittedComposerContexts() {
    if (!state.submittedComposerSubmissions.length) return;
    for (const submission of state.submittedComposerSubmissions) {
      const marker = `[[CLANKERBEND_CONTEXT:${submission.submissionId}]]`;
      const candidates = Array.from(document.querySelectorAll("main *, [role='main'] *, body *"))
        .filter((el) => el instanceof HTMLElement && !isHostUiElement(el))
        .filter((el) => (el.innerText || el.textContent || "").includes(marker))
        .filter((el) => !Array.from(el.children || []).some((child) => (child.innerText || child.textContent || "").includes(marker)))
        .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
      const target = candidates[0];
      if (!target || target.dataset.clankerbendMaskedSubmission === submission.submissionId) continue;
      target.dataset.clankerbendMaskedSubmission = submission.submissionId;
      const prompt = document.createElement("span");
      prompt.textContent = submission.userText || "";
      target.replaceChildren(submittedChipRow(submission), prompt);
    }
  }

  function scheduleSubmittedContextMask() {
    for (const delayMs of [50, 150, 350, 800, 1600, 3000]) {
      const timer = setTimeout(maskSubmittedComposerContexts, delayMs);
      timer?.unref?.();
    }
  }

  function prepareComposerContextForSubmit() {
    const items = activeComposerSubmitItems();
    if (!items.length) return false;
    const input = composerInputElement();
    if (!input) return false;
    const userText = composerText(input).trim();
    const submission = {
      submissionId: `sub_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      userText,
      items: items.map((item) => ({ ...item })),
      submittedAt: Date.now()
    };
    const nextText = clankerbendSubmitPrompt(submission);
    if (!setComposerText(input, nextText)) return false;
    state.pendingComposerSubmission = submission;
    state.submittedComposerSubmissions = [...state.submittedComposerSubmissions, submission].slice(-8);
    enqueueHostEvent({
      kind: "composerContextSubmitted",
      itemIds: items.filter((item) => item.kind !== "runtime-file").map((item) => item.itemId)
    });
    enqueueHostEvent({
      kind: "composerAttachmentsSubmitted",
      paths: items.filter((item) => item.kind === "runtime-file").map((item) => item.path).filter(Boolean)
    });
    scheduleSubmittedContextMask();
    return true;
  }

  function isComposerSubmitButton(target) {
    const button = target?.closest?.("button,[role='button']");
    if (!(button instanceof HTMLElement) || button.disabled) return false;
    if (isHostUiElement(button)) return false;
    const label = [
      button.getAttribute?.("aria-label") || "",
      button.getAttribute?.("title") || "",
      button.innerText || button.textContent || ""
    ].join(" ");
    if (/send|submit|arrow/i.test(label)) return true;
    const composer = composerAnchorElement();
    const buttonRect = button.getBoundingClientRect?.();
    const composerRect = composer?.getBoundingClientRect?.();
    return Boolean(buttonRect && composerRect &&
      buttonRect.left >= composerRect.left &&
      buttonRect.right <= composerRect.right + 8 &&
      buttonRect.top >= composerRect.top - 8 &&
      buttonRect.bottom <= composerRect.bottom + 8);
  }

  function installComposerSubmitInterceptor() {
    if (window.__clankerbendComposerSubmitInterceptorInstalled) return;
    window.__clankerbendComposerSubmitInterceptorInstalled = true;
    window.__clankerbendComposerSubmitClickHandler = (event) => {
      if (isComposerSubmitButton(event.target)) prepareComposerContextForSubmit();
    };
    window.__clankerbendComposerSubmitKeyHandler = (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      const input = composerInputElement();
      if (input && (event.target === input || input.contains?.(event.target))) prepareComposerContextForSubmit();
    };
    document.addEventListener("click", window.__clankerbendComposerSubmitClickHandler, true);
    document.addEventListener("keydown", window.__clankerbendComposerSubmitKeyHandler, true);
  }

  function clankerbendAppUrl() {
    return String(clankerbendRuntime().getEntryUrl(VIM_NAV_APP_ID) || "").trim();
  }

  async function ensureNativeBrowserPanel() {
    if (browserUrlInput()) return true;
    const waitForBrowserButton = async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const button = nativeBrowserButton();
        if (button) return button;
        await delay(100);
      }
      return nativeBrowserButton();
    };
    const waitForBrowserControls = async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (browserUrlInput() || localServerButton()) return true;
        await delay(100);
      }
      return Boolean(browserUrlInput() || localServerButton());
    };
    let browserButton = nativeBrowserButton();
    if (browserButton) {
      browserButton.click();
      return waitForBrowserControls();
    }
    const toggle = toggleSidePanelButton();
    if (toggle) {
      toggle.click();
      const revealed = await waitForBrowserButton();
      if (revealed) {
        revealed.click();
        return waitForBrowserControls();
      }
    }
    return Boolean(browserUrlInput() || localServerButton());
  }

  async function openPanel() {
    if (state.panelOpenPromise) return state.panelOpenPromise;
    state.panelOpenPromise = doOpenPanel().then((result) => {
      state.lastPanelResult = result;
      return result;
    }, (err) => {
      state.lastPanelResult = { ok: false, error: err?.message || String(err) };
      throw err;
    }).finally(() => {
      state.panelOpenPromise = null;
    });
    return state.panelOpenPromise;
  }

  async function doOpenPanel() {
    const serverUrl = clankerbendAppUrl().replace(/\/$/, "");
    if (!serverUrl) return { ok: false, error: "ClankerBend host URL missing" };
    const panelUrl = `${serverUrl}/`;
    const webviews = () => Array.from(document.querySelectorAll("webview, iframe"));
    const normalizedSrc = (el) => String(el.getAttribute("src") || "")
      .replace("localhost", "127.0.0.1")
      .replace(/\/$/, "");
    const isPanelUrl = (src) =>
      src === serverUrl || src.startsWith(`${serverUrl}/`) || src.startsWith(`${serverUrl}#`) || src.startsWith(`${serverUrl}?`);
    const isVisiblePanel = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 160 &&
        rect.height > 160 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0";
    };
    const matchingPanel = () => webviews().find((el) => isPanelUrl(normalizedSrc(el)) && isVisiblePanel(el));
    const waitForPanel = async (timeoutMs = 1200) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (matchingPanel()) return true;
        await delay(100);
      }
      return Boolean(matchingPanel());
    };
    const setInputValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(input.constructor?.prototype || HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const submitUrlInput = async (mode) => {
      const input = browserUrlInput();
      if (!input) return null;
      input.focus();
      setInputValue(input, panelUrl);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
      await delay(900);
      if (await waitForPanel(900)) return { ok: true, mode };
      return null;
    };
    if (matchingPanel()) return { ok: true, mode: "already-open" };
    const navigateBlankWebview = async () => {
      const target = webviews().find((el) => {
        const src = normalizedSrc(el);
        return !src || src === "about:blank";
      });
      if (!target) return null;
      target.setAttribute("src", panelUrl);
      target.src = panelUrl;
      await delay(900);
      return matchingPanel()
        ? { ok: true, mode: "navigated-blank-webview" }
        : null;
    };
    const installPanelIframe = async () => {
      const existing = document.getElementById("clankerbend-vim-nav-side-panel-frame");
      if (existing) {
        existing.setAttribute("src", panelUrl);
        await delay(300);
        return matchingPanel() ? { ok: true, mode: "injected-panel-iframe-existing" } : null;
      }
      const input = browserUrlInput();
      if (!input && !localServerButton()) return null;
      const inputRect = input?.getBoundingClientRect?.();
      const candidates = Array.from(document.querySelectorAll("[role='tabpanel'], aside, section, main, div"))
        .map((el) => ({ el, rect: el.getBoundingClientRect(), text: textOf(el) }))
        .filter(({ rect }) =>
          rect.width > 240 &&
          rect.height > 240 &&
          rect.left > window.innerWidth * 0.45 &&
          rect.top < Math.max(120, (inputRect?.top || 0) + 80) &&
          rect.bottom > window.innerHeight * 0.5
        )
        .sort((a, b) => {
          const aInput = input && a.el.contains(input) ? 1 : 0;
          const bInput = input && b.el.contains(input) ? 1 : 0;
          if (aInput !== bInput) return bInput - aInput;
          const aBrowser = /new tab|start browsing|enter a url|browser/i.test(a.text) ? 1 : 0;
          const bBrowser = /new tab|start browsing|enter a url|browser/i.test(b.text) ? 1 : 0;
          if (aBrowser !== bBrowser) return bBrowser - aBrowser;
          return (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height);
        });
      const panel = candidates[0]?.el;
      if (!(panel instanceof HTMLElement)) return null;
      const panelText = textOf(panel);
      if (!input && !/new tab|start browsing|enter a url|browser/i.test(panelText)) return null;
      if (getComputedStyle(panel).position === "static") panel.style.position = "relative";
      const frame = document.createElement("iframe");
      frame.id = "clankerbend-vim-nav-side-panel-frame";
      frame.src = panelUrl;
      frame.title = "VimNav";
      frame.setAttribute("data-clankerbend-panel-frame", VIM_NAV_APP_ID);
      frame.style.cssText = [
        "position:absolute",
        "left:0",
        "right:0",
        "bottom:0",
        "top:44px",
        "width:100%",
        "height:calc(100% - 44px)",
        "border:0",
        "background:#05090c",
        "z-index:2147482500"
      ].join(";");
      panel.appendChild(frame);
      await delay(500);
      return matchingPanel() ? { ok: true, mode: "injected-panel-iframe" } : null;
    };
    await ensureNativeBrowserPanel();
    if (await waitForPanel(300)) return { ok: true, mode: "already-open" };
    const blankResult = await navigateBlankWebview();
    if (blankResult) return blankResult;
    const inputBeforeServerButton = await submitUrlInput("opened-url-input");
    if (inputBeforeServerButton) return inputBeforeServerButton;
    const serverButton = localServerButton();
    if (serverButton) {
      serverButton.click();
      await delay(900);
      if (await waitForPanel(900)) return { ok: true, mode: "opened-local-server" };
      const serverButtonResult = await navigateBlankWebview();
      if (serverButtonResult) return serverButtonResult;
      const inputAfterServerButton = await submitUrlInput("opened-url-input-after-local-server");
      if (inputAfterServerButton) return inputAfterServerButton;
    }
    const finalInputResult = await submitUrlInput("opened-url-input-final");
    if (finalInputResult) return finalInputResult;
    const finalBlankResult = await navigateBlankWebview();
    if (finalBlankResult) return finalBlankResult;
    const iframeResult = await installPanelIframe();
    if (iframeResult) return iframeResult;
    if (!browserUrlInput() && !localServerButton()) {
      return { ok: false, error: "native Browser panel controls not found", debug: panelDebug({ stage: "no-controls" }) };
    }
    return { ok: false, error: "native Browser panel did not navigate to VimNav", debug: panelDebug({ stage: "not-navigated" }) };
  }

  function shouldIgnoreKey(event) {
    if (effectiveCommandOption(event)) return false;
    if (event.metaKey) return true;
    if (state.vimMode) return false;
    if (event.defaultPrevented) return true;
    if (event.ctrlKey || event.altKey) return true;
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable;
  }

  function isModifierOnlyKey(event) {
    return event.key === "Meta" ||
      event.key === "Alt" ||
      event.code === "MetaLeft" ||
      event.code === "MetaRight" ||
      event.code === "AltLeft" ||
      event.code === "AltRight";
  }

  function updateModifierState(event, isDown) {
    if (event.key === "Meta" || event.code === "MetaLeft" || event.code === "MetaRight") {
      state.metaDown = Boolean(isDown);
    }
    if (event.key === "Alt" || event.code === "AltLeft" || event.code === "AltRight") {
      state.altDown = Boolean(isDown);
    }
  }

  function effectiveCommandOption(event) {
    return Boolean((event.metaKey && event.altKey) || (state.metaDown && state.altDown));
  }

  function digitFromKeyEvent(event) {
    if (/^\d$/.test(event.key)) return event.key;
    const digitMatch = /^Digit(\d)$/.exec(event.code || "");
    if (digitMatch) return digitMatch[1];
    const numpadMatch = /^Numpad(\d)$/.exec(event.code || "");
    return numpadMatch ? numpadMatch[1] : null;
  }

  function handleKey(event) {
    updateModifierState(event, true);
    state.keyEventCount += 1;
    state.lastKey = {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      vimMode: state.vimMode,
      at: Date.now()
    };
    if (shouldIgnoreKey(event)) return;
    const key = event.key;
    const code = event.code;
    const runCommand = (name, command) => {
      const prefixBefore = state.countPrefix;
      state.commandChain = state.commandChain
        .catch(() => {})
        .then(() => Promise.resolve().then(command))
        .then((result) => {
          state.lastCommandResult = { name, prefixBefore, result };
          ensureModeBadge();
          return result;
        }, (err) => {
          state.lastCommandResult = { name, prefixBefore, ok: false, error: err?.message || String(err) };
          ensureModeBadge();
          return null;
        });
    };
    const runRelativeCommand = (name, delta, commandForDelta) => {
      if (state.relativeMoveInFlight) {
        state.pendingRelativeDelta = Math.max(-1, Math.min(1, state.pendingRelativeDelta + Math.sign(delta)));
        state.lastCommandResult = { name, pending: true, pendingRelativeDelta: state.pendingRelativeDelta };
        ensureModeBadge();
        return;
      }
      const prefixBefore = state.countPrefix;
      state.relativeMoveInFlight = true;
      state.commandChain = state.commandChain
        .catch(() => {})
        .then(async () => {
          let step = Math.sign(delta);
          let result = null;
          try {
            while (step) {
              result = await Promise.resolve().then(() => commandForDelta(step));
              state.lastCommandResult = { name, prefixBefore, result };
              ensureModeBadge();
              step = state.pendingRelativeDelta;
              state.pendingRelativeDelta = 0;
            }
            return result;
          } catch (err) {
            state.lastCommandResult = { name, prefixBefore, ok: false, error: err?.message || String(err) };
            ensureModeBadge();
            return null;
          } finally {
            state.relativeMoveInFlight = false;
          }
        });
    };
    if (effectiveCommandOption(event)) {
      if (isModifierOnlyKey(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat && !state.metaAltToggleDown) {
          state.metaAltToggleDown = true;
          setVimMode(!state.vimMode);
        }
        return;
      }
      const isRelativeMoveKey = code === "KeyJ" || key === "j" || key === "ArrowDown" ||
        code === "KeyK" || key === "k" || key === "ArrowUp";
      if (!hasAppServerOrder() && key !== "?" && !isRelativeMoveKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        orderPendingResult();
        return;
      }
      if (code === "KeyJ" || key === "j" || key === "ArrowDown") {
        event.preventDefault();
        event.stopImmediatePropagation();
        runRelativeCommand("cmd-option-j", 1, (step) => withVisibleMountedIndex(() => jumpRelativeFast(step)));
      } else if (code === "KeyK" || key === "k" || key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        runRelativeCommand("cmd-option-k", -1, (step) => withVisibleMountedIndex(() => jumpRelativeFast(step)));
      } else if ((code === "KeyG" && event.shiftKey) || key === "G" || key === "End") {
        event.preventDefault();
        event.stopImmediatePropagation();
        runCommand("cmd-option-G", () => afterIndexing(() => jumpToBottom()));
      } else if (code === "KeyG" || key === "g" || key === "Home") {
        event.preventDefault();
        event.stopImmediatePropagation();
        runCommand("cmd-option-g", () => afterIndexing(() => jumpToIndex(0, { block: "start", behavior: "auto" })));
      } else if (key === "[" || (code === "BracketLeft" && !event.shiftKey)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        runCommand("cmd-option-[", () => alignCurrent("start"));
      } else if (key === "]" || (code === "BracketRight" && !event.shiftKey)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        runCommand("cmd-option-]", () => alignCurrent("end"));
      } else if (key === "{" || (code === "BracketLeft" && event.shiftKey) || key === "PageUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        runCommand("cmd-option-{", () => jumpRole("user", -1));
      } else if (key === "}" || (code === "BracketRight" && event.shiftKey) || key === "PageDown") {
        event.preventDefault();
        event.stopImmediatePropagation();
        runCommand("cmd-option-}", () => jumpRole("user", 1));
      } else if (key === "?" || (code === "Slash" && event.shiftKey)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleHelp();
      }
      return;
    }

    if (state.vimMode) {
      if (key === "Escape" || key === "i") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setVimMode(false);
        return;
      }
      if (key === "?" || (code === "Slash" && event.shiftKey)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleHelp();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const isRelativeMoveKey = code === "KeyJ" || key === "j" || code === "KeyK" || key === "k";
      if (!hasAppServerOrder() && !isRelativeMoveKey) {
        orderPendingResult();
        return;
      }
    }

    if (key === "Backspace" || code === "Backspace") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (state.countPrefix) {
        state.countPrefix = state.countPrefix.slice(0, -1);
      } else if (state.pendingKeys) {
        state.pendingKeys = "";
      }
      ensureModeBadge();
      return;
    }

    if (state.pendingKeys === "g") {
      state.pendingKeys = "";
      state.countPrefix = "";
      ensureModeBadge();
      if ((code === "KeyG" && !event.shiftKey) || key === "g") {
        event.preventDefault();
        runCommand("gg", () => afterIndexing(() => jumpToIndex(0, { block: "start", behavior: "auto" })));
      }
      return;
    }
    const digit = digitFromKeyEvent(event);
    if (digit != null) {
      event.preventDefault();
      state.countPrefix = `${state.countPrefix}${digit}`.replace(/^0+(?=\d)/, "");
      state.lastDigit = {
        digit,
        key,
        code,
        prefix: state.countPrefix,
        at: Date.now()
      };
      ensureModeBadge();
      return;
    }

    if (code === "KeyJ" || key === "j") {
      event.preventDefault();
      state.countPrefix = "";
      ensureModeBadge();
      runRelativeCommand("j", 1, (step) => withVisibleMountedIndex(() => jumpRelativeFast(step)));
    } else if (code === "KeyK" || key === "k") {
      event.preventDefault();
      state.countPrefix = "";
      ensureModeBadge();
      runRelativeCommand("k", -1, (step) => withVisibleMountedIndex(() => jumpRelativeFast(step)));
    } else if ((code === "KeyG" && event.shiftKey) || key === "G") {
      event.preventDefault();
      const prefix = state.countPrefix;
      state.countPrefix = "";
      ensureModeBadge();
      runCommand("G", () => afterIndexing(() => jumpToCountOrLast(prefix)));
    } else if ((code === "KeyG" && !event.shiftKey) || key === "g") {
      event.preventDefault();
      state.countPrefix = "";
      state.pendingKeys = "g";
      ensureModeBadge();
    } else if (key === "[" || (code === "BracketLeft" && !event.shiftKey)) {
      event.preventDefault();
      state.countPrefix = "";
      ensureModeBadge();
      runCommand("[", () => alignCurrent("start"));
    } else if (key === "]" || (code === "BracketRight" && !event.shiftKey)) {
      event.preventDefault();
      state.countPrefix = "";
      ensureModeBadge();
      runCommand("]", () => alignCurrent("end"));
    } else if (key === "{" || (code === "BracketLeft" && event.shiftKey)) {
      event.preventDefault();
      state.countPrefix = "";
      ensureModeBadge();
      runCommand("{", () => jumpRole("user", -1));
    } else if (key === "}" || (code === "BracketRight" && event.shiftKey)) {
      event.preventDefault();
      state.countPrefix = "";
      ensureModeBadge();
      runCommand("}", () => jumpRole("user", 1));
    }
  }

  function handleKeyUp(event) {
    updateModifierState(event, false);
    if ((event.key === "Meta" || event.key === "Alt" || !event.metaKey || !event.altKey) &&
        state.metaAltToggleDown &&
        !effectiveCommandOption(event)) {
      state.metaAltToggleDown = false;
    }
  }

  function handlePossibleTextSelection() {
    setTimeout(() => {
      const changed = updateTextSelectionFromDom();
      if (!changed && !window.getSelection?.()?.toString?.().trim()) {
        state.activeTextSelection = null;
        hideSelectionMenu();
      }
    }, 0);
  }

  function resetModifierState() {
    state.metaDown = false;
    state.altDown = false;
    state.metaAltToggleDown = false;
  }

  function snapshot() {
    ensureAnnotations();
    const root = findScrollContainer();
    const items = anchors();
    if (!state.currentAnchorId && items.length) {
      const firstVisible = items.find((item) => item.visible) || items[0];
      setCurrent(firstVisible.anchorId, "adapter");
    } else if (state.currentAnchorId && state.selection?.anchorId !== state.currentAnchorId) {
      setCurrent(state.currentAnchorId, "adapter");
    }
    return {
      href: location.href,
      title: document.title,
      version: state.version,
      scroll: {
        top: Math.round(root.scrollTop),
        height: Math.round(root.scrollHeight),
        clientHeight: Math.round(root.clientHeight)
      },
      anchors: items,
      visibleCount: items.filter((item) => item.visible).length,
      annotationCount: document.querySelectorAll(`.${ANNOTATION_CLASS}`).length,
      selection: state.selection,
      vimMode: state.vimMode,
      transcriptOrderSource: state.transcriptOrderSource,
      mountedContentAnchorIds: collectAnchorIds().filter(isContentUnitId),
      unknownMountedAnchorCount: mountedUnknownContentAnchorIds().length,
      mountedTurnSearchKeys: Array.from(new Set(collectAnchorIds()
        .map((id) => contentUnitSortKey(id)?.turnSearchKey)
        .filter(Boolean))),
      panel: state.lastPanelResult,
      debug: {
        keyEventCount: state.keyEventCount,
        lastKey: state.lastKey,
        countPrefix: state.countPrefix,
        lastDigit: state.lastDigit,
        lastCommandResult: state.lastCommandResult,
        lastRelativeDebug: state.lastRelativeDebug,
        lastMountSearch: state.lastMountSearch,
        lastBottomJump: state.lastBottomJump,
        lastOrderFallback: state.lastOrderFallback,
        lastFocusTarget: state.lastFocusTarget || null
      }
    };
  }

  window.removeEventListener("keydown", window.__codexVimNavKeyHandler, true);
  document.removeEventListener("keydown", window.__codexVimNavKeyHandler, true);
  window.removeEventListener("keyup", window.__codexVimNavKeyUpHandler, true);
  document.removeEventListener("keyup", window.__codexVimNavKeyUpHandler, true);
  document.removeEventListener("mouseup", window.__clankerbendTextSelectionHandler, true);
  window.__codexVimNavKeyHandler = handleKey;
  window.__codexVimNavKeyUpHandler = handleKeyUp;
  window.__clankerbendTextSelectionHandler = handlePossibleTextSelection;
  window.addEventListener("keydown", handleKey, true);
  document.addEventListener("keydown", handleKey, true);
  window.addEventListener("keyup", handleKeyUp, true);
  document.addEventListener("keyup", handleKeyUp, true);
  document.addEventListener("mouseup", handlePossibleTextSelection, true);
  const resizeHandler = () => { state.version += 1; scheduleAnnotationRefresh(); };
  const blurHandler = () => resetModifierState();
  const mutationObserver = new MutationObserver(() => {
    state.version += 1;
    scheduleAnnotationRefresh();
    renderCodexAccountSwitcher();
    maskSubmittedComposerContexts();
  });
  window.addEventListener("resize", resizeHandler);
  window.addEventListener("blur", blurHandler);
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  window.__codexVimNavCleanup = () => {
    window.removeEventListener("keydown", handleKey, true);
    document.removeEventListener("keydown", handleKey, true);
    window.removeEventListener("keyup", handleKeyUp, true);
    document.removeEventListener("keyup", handleKeyUp, true);
    document.removeEventListener("mouseup", handlePossibleTextSelection, true);
    document.removeEventListener("click", window.__clankerbendComposerSubmitClickHandler, true);
    document.removeEventListener("keydown", window.__clankerbendComposerSubmitKeyHandler, true);
    document.getElementById(ACCOUNT_SWITCHER_ID)?.remove();
    window.removeEventListener("resize", resizeHandler);
    window.removeEventListener("blur", blurHandler);
    mutationObserver.disconnect();
    if (annotationRefreshTimer) clearTimeout(annotationRefreshTimer);
    annotationRefreshTimer = null;
    window.__clankerbendComposerSubmitInterceptorInstalled = false;
  };

  const bridge = {
    name: "vim-nav",
    version: BRIDGE_VERSION,
    snapshot,
    applyHostState,
    drainHostEvents,
    openPanel,
    scrollToAnchor,
    highlightAnchor,
    highlightRange: (range, options) => clankerbendRuntime().highlightRange
      ? clankerbendRuntime().highlightRange(range, options)
      : highlightAnchor(range?.anchorId, options),
    setAnnotations,
    setTranscriptOrder,
    primeAnchorOrder,
    jumpToIndex,
    jumpRelativeFast,
    __testUpdateTextSelectionFromDom: updateTextSelectionFromDom
  };

  clankerbendRuntime().registerApp({
    appId: VIM_NAV_APP_ID,
    capabilities: {
      transcriptRead: true,
      transcriptAnnotate: true,
      transcriptNavigate: true,
      commands: true
    },
    bridge
  });
  return primeAnchorOrder().then(() => snapshot()).catch(() => {
    freezeCurrentDomOrder({ selectCurrent: false, annotate: true });
    return snapshot();
  });
})();
