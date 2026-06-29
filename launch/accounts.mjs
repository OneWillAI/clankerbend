import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const ACCOUNT_REGISTRY_VERSION = 1;
export const PRIMARY_ACCOUNT_ID = "primary";
export const MAX_ACCOUNT_PROFILES = 20;

export function primaryCodexHome() {
  return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
}

export class CodexAccountRegistry {
  constructor(options = {}) {
    if (!options.root) throw new Error("account registry root is required");
    if (!options.primaryElectronProfile) throw new Error("primary electron profile is required");
    this.root = resolve(options.root);
    this.registryPath = options.registryPath || join(this.root, "accounts.json");
    this.accountsDir = options.accountsDir || join(this.root, "accounts");
    this.deletedDir = options.deletedDir || join(this.root, "deleted-accounts");
    this.primaryCodexHome = resolve(options.primaryCodexHome || primaryCodexHome());
    this.primaryElectronProfile = resolve(options.primaryElectronProfile);
    this.maxAccounts = options.maxAccounts || MAX_ACCOUNT_PROFILES;
    this.registry = this.load();
  }

  list() {
    this.ensurePrimary();
    return {
      version: ACCOUNT_REGISTRY_VERSION,
      clankerbendDefaultAccountId: this.registry.clankerbendDefaultAccountId || PRIMARY_ACCOUNT_ID,
      maxAccounts: this.maxAccounts,
      accounts: this.registry.accounts.map((account) => this.publicAccount(account)),
      backups: this.registry.backups || [],
      deletedAccounts: this.registry.deletedAccounts || []
    };
  }

  get(id) {
    this.ensurePrimary();
    const account = this.registry.accounts.find((candidate) => candidate.id === id);
    if (!account) throw new Error(`unknown Codex account profile: ${id}`);
    return account;
  }

  getDefault() {
    const id = this.registry.clankerbendDefaultAccountId || PRIMARY_ACCOUNT_ID;
    return this.registry.accounts.find((account) => account.id === id) || this.get(PRIMARY_ACCOUNT_ID);
  }

  createManaged(input = {}) {
    this.ensurePrimary();
    if (this.registry.accounts.length >= this.maxAccounts) {
      throw new Error(`Codex account profile limit reached (${this.maxAccounts})`);
    }
    const id = input.id
      ? safeAccountId(input.id)
      : uniqueAccountId(this.registry.accounts, accountIdFromLabel(input.label || "account"));
    if (input.id && this.registry.accounts.some((account) => account.id === id)) {
      throw new Error(`Codex account profile already exists: ${id}`);
    }
    const accountRoot = join(this.accountsDir, id);
    const codexHome = join(accountRoot, "codex-home");
    const electronProfile = join(accountRoot, "electron-profile");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(electronProfile, { recursive: true, mode: 0o700 });
    writeManagedConfig(codexHome, this.primaryCodexHome);
    const account = {
      id,
      kind: "managed",
      label: String(input.label || id),
      codexHome,
      electronProfile,
      createdAt: new Date().toISOString(),
      createdFrom: PRIMARY_ACCOUNT_ID
    };
    this.registry.accounts.push(account);
    this.save();
    return this.publicAccount(account);
  }

  setDefault(id) {
    this.get(id);
    this.registry.clankerbendDefaultAccountId = id;
    this.save();
    return this.list();
  }

  adoptAsPrimary(id) {
    const target = this.get(id);
    if (target.kind === "primary") throw new Error("primary account is already the primary Codex home");
    const timestamp = timestampSegment();
    const primary = this.get(PRIMARY_ACCOUNT_ID);
    const oldPrimaryId = uniqueAccountId(this.registry.accounts, `previous-primary-${timestamp}`);
    const backupCodexHome = `${this.primaryCodexHome}.backup_${timestamp}`;
    const oldPrimaryElectronProfile = join(this.accountsDir, oldPrimaryId, "electron-profile");
    const rollbackBackup = {
      id: oldPrimaryId,
      label: `Previous Primary ${timestamp}`,
      codexHome: backupCodexHome,
      createdAt: new Date().toISOString(),
      reason: "adopt-as-primary"
    };

    if (!existsSync(target.codexHome)) throw new Error(`target CODEX_HOME does not exist: ${target.codexHome}`);
    if (existsSync(backupCodexHome)) throw new Error(`backup path already exists: ${backupCodexHome}`);

    if (existsSync(this.primaryCodexHome)) movePath(this.primaryCodexHome, backupCodexHome);
    if (existsSync(primary.electronProfile)) movePath(primary.electronProfile, oldPrimaryElectronProfile);
    movePath(target.codexHome, this.primaryCodexHome);
    if (existsSync(target.electronProfile)) movePath(target.electronProfile, primary.electronProfile);
    else mkdirSync(primary.electronProfile, { recursive: true, mode: 0o700 });

    const oldPrimary = {
      id: oldPrimaryId,
      kind: "managed",
      label: rollbackBackup.label,
      codexHome: backupCodexHome,
      electronProfile: oldPrimaryElectronProfile,
      createdAt: rollbackBackup.createdAt,
      createdFrom: PRIMARY_ACCOUNT_ID,
      backup: true
    };
    primary.lastAdoptedFrom = target.id;
    primary.lastAdoptedAt = new Date().toISOString();
    primary.codexHome = this.primaryCodexHome;
    primary.electronProfile = this.primaryElectronProfile;
    this.registry.accounts = this.registry.accounts
      .filter((account) => account.id !== target.id)
      .map((account) => account.id === PRIMARY_ACCOUNT_ID ? primary : account);
    this.registry.accounts.push(oldPrimary);
    this.registry.backups = [...(this.registry.backups || []), rollbackBackup];
    this.registry.clankerbendDefaultAccountId = PRIMARY_ACCOUNT_ID;
    this.save();
    return {
      adoptedAccountId: id,
      primary: this.publicAccount(primary),
      previousPrimary: this.publicAccount(oldPrimary),
      backup: rollbackBackup
    };
  }

  rollbackPrimary(input = {}) {
    const backupId = input.backupId || input.accountId;
    if (!backupId) throw new Error("backupId is required");
    const backupAccount = this.get(backupId);
    if (backupAccount.kind === "primary") throw new Error("cannot rollback from primary account");
    if (!existsSync(backupAccount.codexHome)) throw new Error(`backup CODEX_HOME does not exist: ${backupAccount.codexHome}`);

    const timestamp = timestampSegment();
    const primary = this.get(PRIMARY_ACCOUNT_ID);
    const replacedId = uniqueAccountId(this.registry.accounts, `rollback-replaced-${timestamp}`);
    const replacedCodexHome = `${this.primaryCodexHome}.rollback_replaced_${timestamp}`;
    const replacedElectronProfile = join(this.accountsDir, replacedId, "electron-profile");

    if (existsSync(this.primaryCodexHome)) movePath(this.primaryCodexHome, replacedCodexHome);
    if (existsSync(primary.electronProfile)) movePath(primary.electronProfile, replacedElectronProfile);
    movePath(backupAccount.codexHome, this.primaryCodexHome);
    if (existsSync(backupAccount.electronProfile)) movePath(backupAccount.electronProfile, primary.electronProfile);
    else mkdirSync(primary.electronProfile, { recursive: true, mode: 0o700 });

    const replacedAccount = {
      id: replacedId,
      kind: "managed",
      label: `Rollback Replaced ${timestamp}`,
      codexHome: replacedCodexHome,
      electronProfile: replacedElectronProfile,
      createdAt: new Date().toISOString(),
      createdFrom: PRIMARY_ACCOUNT_ID,
      backup: true
    };
    primary.lastRollbackFrom = backupAccount.id;
    primary.lastRollbackAt = new Date().toISOString();
    primary.codexHome = this.primaryCodexHome;
    primary.electronProfile = this.primaryElectronProfile;
    this.registry.accounts = this.registry.accounts
      .filter((account) => account.id !== backupAccount.id)
      .map((account) => account.id === PRIMARY_ACCOUNT_ID ? primary : account);
    this.registry.accounts.push(replacedAccount);
    this.registry.backups = [...(this.registry.backups || []), {
      id: replacedId,
      label: replacedAccount.label,
      codexHome: replacedCodexHome,
      createdAt: replacedAccount.createdAt,
      reason: "rollback-replaced-primary"
    }];
    this.registry.clankerbendDefaultAccountId = PRIMARY_ACCOUNT_ID;
    this.save();
    return {
      restoredAccountId: backupAccount.id,
      primary: this.publicAccount(primary),
      replacedPrimary: this.publicAccount(replacedAccount)
    };
  }

  deleteManaged(id) {
    const account = this.get(id);
    if (account.kind === "primary") throw new Error("primary account cannot be deleted");
    const timestamp = timestampSegment();
    const deleteRoot = join(this.deletedDir, `${id}_${timestamp}`);
    mkdirSync(deleteRoot, { recursive: true, mode: 0o700 });
    const deleted = {
      id,
      label: account.label,
      deletedAt: new Date().toISOString(),
      originalCodexHome: account.codexHome,
      originalElectronProfile: account.electronProfile,
      deletedRoot: deleteRoot,
      codexHome: null,
      electronProfile: null
    };
    if (existsSync(account.codexHome)) {
      const destination = join(deleteRoot, "codex-home");
      movePath(account.codexHome, destination);
      deleted.codexHome = destination;
    }
    if (existsSync(account.electronProfile)) {
      const destination = join(deleteRoot, "electron-profile");
      movePath(account.electronProfile, destination);
      deleted.electronProfile = destination;
    }
    this.registry.accounts = this.registry.accounts.filter((candidate) => candidate.id !== id);
    if (this.registry.clankerbendDefaultAccountId === id) this.registry.clankerbendDefaultAccountId = PRIMARY_ACCOUNT_ID;
    this.registry.deletedAccounts = [...(this.registry.deletedAccounts || []), deleted];
    this.save();
    return deleted;
  }

  load() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(this.accountsDir, { recursive: true, mode: 0o700 });
    let registry = null;
    if (existsSync(this.registryPath)) {
      registry = JSON.parse(readFileSync(this.registryPath, "utf8"));
    }
    registry ||= {
      version: ACCOUNT_REGISTRY_VERSION,
      clankerbendDefaultAccountId: PRIMARY_ACCOUNT_ID,
      accounts: [],
      backups: [],
      deletedAccounts: []
    };
    registry.version = ACCOUNT_REGISTRY_VERSION;
    registry.accounts = Array.isArray(registry.accounts) ? registry.accounts : [];
    registry.backups = Array.isArray(registry.backups) ? registry.backups : [];
    registry.deletedAccounts = Array.isArray(registry.deletedAccounts) ? registry.deletedAccounts : [];
    this.registry = registry;
    this.ensurePrimary();
    return this.registry;
  }

  ensurePrimary() {
    const primary = this.registry.accounts.find((account) => account.id === PRIMARY_ACCOUNT_ID);
    if (primary) {
      primary.kind = "primary";
      primary.label ||= "Primary";
      primary.codexHome = this.primaryCodexHome;
      primary.electronProfile = this.primaryElectronProfile;
      return primary;
    }
    const account = {
      id: PRIMARY_ACCOUNT_ID,
      kind: "primary",
      label: "Primary",
      codexHome: this.primaryCodexHome,
      electronProfile: this.primaryElectronProfile,
      createdAt: new Date().toISOString()
    };
    this.registry.accounts.unshift(account);
    this.registry.clankerbendDefaultAccountId ||= PRIMARY_ACCOUNT_ID;
    this.save();
    return account;
  }

  save() {
    mkdirSync(dirname(this.registryPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.registryPath, `${JSON.stringify(this.registry, null, 2)}\n`, { mode: 0o600 });
  }

  publicAccount(account) {
    return {
      id: account.id,
      kind: account.kind,
      label: account.label,
      codexHome: account.codexHome,
      electronProfile: account.electronProfile,
      auth: {
        authJson: existsSync(join(account.codexHome, "auth.json")),
        configToml: existsSync(join(account.codexHome, "config.toml"))
      },
      createdAt: account.createdAt,
      createdFrom: account.createdFrom,
      backup: account.backup || undefined,
      lastSeenAccount: account.lastSeenAccount || undefined,
      lastAdoptedFrom: account.lastAdoptedFrom || undefined,
      lastAdoptedAt: account.lastAdoptedAt || undefined,
      lastRollbackFrom: account.lastRollbackFrom || undefined,
      lastRollbackAt: account.lastRollbackAt || undefined
    };
  }
}

function writeManagedConfig(codexHome, primaryHome) {
  const primaryConfig = join(primaryHome, "config.toml");
  let content = "";
  if (existsSync(primaryConfig)) {
    const match = readFileSync(primaryConfig, "utf8").match(/^\s*cli_auth_credentials_store\s*=.*$/m);
    if (match) content = `${match[0].trim()}\n`;
  }
  if (!content && existsSync(join(primaryHome, "auth.json"))) {
    content = "cli_auth_credentials_store = \"file\"\n";
  }
  if (content) writeFileSync(join(codexHome, "config.toml"), content, { mode: 0o600 });
}

function accountIdFromLabel(label) {
  const id = String(label || "account")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!id) return "account";
  return /^[a-z]/.test(id) ? id : `account-${id}`.slice(0, 40);
}

function safeAccountId(id) {
  const value = String(id || "").trim();
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(value)) {
    throw new Error("account id must start with a lowercase letter and contain only lowercase letters, numbers, _ or -");
  }
  return value;
}

function uniqueAccountId(accounts, base) {
  let candidate = safeAccountId(base);
  let suffix = 2;
  while (accounts.some((account) => account.id === candidate)) {
    candidate = safeAccountId(`${base}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function timestampSegment(date = new Date()) {
  return date.toISOString().replace(/\..*$/, "").replace("T", "_").replace(/:/g, "");
}

function movePath(from, to) {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch (err) {
    if (err?.code !== "EXDEV") throw err;
    const stat = statSync(from);
    if (stat.isDirectory()) cpSync(from, to, { recursive: true, force: false });
    else cpSync(from, to, { force: false });
    rmSync(from, { recursive: true, force: true });
  }
}
