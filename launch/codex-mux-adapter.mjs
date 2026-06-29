import { createCodexDesktopCdpAdapter } from "../host/src/codex-desktop-cdp-adapter.js";
import { PRIMARY_ACCOUNT_ID } from "./accounts.mjs";

export function createCodexDesktopMuxAdapter(options = {}) {
  return new CodexDesktopMuxAdapter(options);
}

class CodexDesktopMuxAdapter {
  constructor(options = {}) {
    if (!options.accountRegistry) throw new Error("accountRegistry is required");
    this.name = "codex-desktop-mux";
    this.cdp = true;
    this.rendererInjection = true;
    this.rendererFetchToLoopback = false;
    this.accountRegistry = options.accountRegistry;
    this.adapterOptions = options.adapterOptions || {};
    this.providers = options.providers || undefined;
    this.startAccountId = options.startAccountId || null;
    this.host = null;
    this.activeAccountId = null;
    this.activeAdapter = null;
    this.switching = false;
  }

  async start(host) {
    this.host = host;
    const account = this.startAccountId ? this.accountRegistry.get(this.startAccountId) : this.accountRegistry.getDefault();
    await this.switchTo(account.id, { initial: true });
  }

  async stop() {
    await this.stopActive();
  }

  async switchTo(accountId, options = {}) {
    if (this.switching) throw new Error("Codex account switch already in progress");
    this.switching = true;
    try {
      const account = this.accountRegistry.get(accountId);
      if (!options.initial) await this.stopActive();
      this.activeAccountId = account.id;
      this.host.state.codexAccounts = this.accountState();
      this.host.setDesktopStatus({
        cdpStatus: "starting",
        cdpPort: null,
        desktopPid: null,
        target: null,
        error: null
      });
      this.host.updateTranscript({
        anchors: [],
        visibleCount: 0,
        annotationCount: 0,
        scroll: null,
        updatedAt: new Date().toISOString()
      }, { broadcast: false });
      this.activeAdapter = createCodexDesktopCdpAdapter({
        ...this.adapterOptions,
        profileDir: account.electronProfile,
        codexHome: account.codexHome,
        resetProfileDir: false
      });
      await this.activeAdapter.start(this.host);
      this.providers = this.activeAdapter.providers;
      return {
        switched: true,
        activeAccountId: account.id,
        account: this.accountRegistry.publicAccount(account)
      };
    } finally {
      this.switching = false;
      if (this.host) {
        this.host.state.codexAccounts = this.accountState();
        this.host.touchAndBroadcast();
      }
    }
  }

  async stopActive() {
    const adapter = this.activeAdapter;
    this.activeAdapter = null;
    if (adapter) await adapter.stop?.();
    if (this.host) {
      this.host.setDesktopStatus({
        cdpStatus: "exited",
        cdpPort: null,
        desktopPid: null,
        target: null,
        error: null
      });
    }
  }

  accountState() {
    return {
      available: true,
      activeAccountId: this.activeAccountId,
      maxRunningDesktopInstances: 1,
      switching: this.switching,
      ...this.accountRegistry.list()
    };
  }

  async createAccount(input = {}) {
    const account = this.accountRegistry.createManaged(input);
    this.host.state.codexAccounts = this.accountState();
    this.host.touchAndBroadcast();
    return account;
  }

  async setDefault(accountId) {
    const result = this.accountRegistry.setDefault(accountId);
    this.host.state.codexAccounts = this.accountState();
    this.host.touchAndBroadcast();
    return result;
  }

  async adoptAsPrimary(accountId) {
    await this.stopActive();
    const result = this.accountRegistry.adoptAsPrimary(accountId);
    const launched = await this.switchTo(PRIMARY_ACCOUNT_ID);
    return { ...result, launched };
  }

  async rollbackPrimary(input = {}) {
    await this.stopActive();
    const result = this.accountRegistry.rollbackPrimary(input);
    const launched = await this.switchTo(PRIMARY_ACCOUNT_ID);
    return { ...result, launched };
  }

  async deleteAccount(accountId) {
    const account = this.accountRegistry.get(accountId);
    if (account.kind === "primary") throw new Error("primary account cannot be deleted");
    if (accountId === this.activeAccountId) await this.stopActive();
    const result = this.accountRegistry.deleteManaged(accountId);
    if (accountId === this.activeAccountId) this.activeAccountId = null;
    this.host.state.codexAccounts = this.accountState();
    this.host.touchAndBroadcast();
    return result;
  }

  active() {
    if (!this.activeAdapter) throw new Error("Codex Desktop is not running");
    return this.activeAdapter;
  }

  openPanel(...args) {
    return this.active().openPanel(...args);
  }

  scrollToAnchor(...args) {
    return this.active().scrollToAnchor(...args);
  }

  highlightAnchor(...args) {
    return this.active().highlightAnchor(...args);
  }

  highlightRange(...args) {
    return this.active().highlightRange(...args);
  }

  setComposerDraft(...args) {
    return this.active().setComposerDraft(...args);
  }

  submitComposer(...args) {
    return this.active().submitComposer(...args);
  }

  attachFiles(...args) {
    return this.active().attachFiles(...args);
  }
}
