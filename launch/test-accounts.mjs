import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClankerBendHost, createMockTranscriptAdapter } from "../host/src/index.js";
import { CodexAccountRegistry, PRIMARY_ACCOUNT_ID } from "./accounts.mjs";

const root = mkdtempSync(join(tmpdir(), "clankerbend-accounts-test-"));

try {
  const primaryHome = join(root, "primary-codex-home");
  const primaryElectronProfile = join(root, "primary-electron-profile");
  mkdirSync(primaryHome, { recursive: true });
  mkdirSync(primaryElectronProfile, { recursive: true });
  writeFileSync(join(primaryHome, "config.toml"), "model = \"gpt-5.4\"\n");
  writeFileSync(join(primaryHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));

  const registry = new CodexAccountRegistry({
    root: join(root, "state"),
    primaryCodexHome: primaryHome,
    primaryElectronProfile
  });

  const listed = registry.list();
  assert.equal(listed.accounts.length, 1);
  assert.equal(listed.accounts[0].id, PRIMARY_ACCOUNT_ID);
  assert.equal(listed.accounts[0].codexHome, primaryHome);

  const work = registry.createManaged({ id: "work", label: "Work" });
  assert.equal(work.id, "work");
  assert.equal(existsSync(work.codexHome), true);
  assert.equal(existsSync(work.electronProfile), true);
  assert.equal(readFileSync(join(work.codexHome, "config.toml"), "utf8"), "cli_auth_credentials_store = \"file\"\n");

  const duplicateLabel = registry.createManaged({ label: "Work" });
  assert.equal(duplicateLabel.id, "work-2");
  const numericLabel = registry.createManaged({ label: "123" });
  assert.equal(numericLabel.id, "account-123");

  writeFileSync(join(work.codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account: "work" } }));
  const adoption = registry.adoptAsPrimary("work");
  assert.equal(existsSync(primaryHome), true);
  assert.equal(JSON.parse(readFileSync(join(primaryHome, "auth.json"), "utf8")).tokens.account, "work");
  assert.equal(adoption.previousPrimary.kind, "managed");
  assert.equal(existsSync(adoption.backup.codexHome), true);
  assert.equal(registry.list().accounts.some((account) => account.id === "work"), false);

  const rollback = registry.rollbackPrimary({ backupId: adoption.previousPrimary.id });
  assert.equal(rollback.restoredAccountId, adoption.previousPrimary.id);
  assert.equal(JSON.parse(readFileSync(join(primaryHome, "auth.json"), "utf8")).tokens.account, undefined);
  assert.equal(registry.list().accounts.some((account) => account.id === rollback.replacedPrimary.id), true);

  const temp = registry.createManaged({ id: "temp", label: "Temp" });
  const deleted = registry.deleteManaged("temp");
  assert.equal(registry.list().accounts.some((account) => account.id === "temp"), false);
  assert.equal(existsSync(deleted.deletedRoot), true);
  assert.equal(existsSync(deleted.codexHome), true);

  const fresh = registry.createManaged({ id: "fresh", label: "Fresh" });
  const host = new ClankerBendHost({
    accountRegistry: registry,
    transcriptAdapter: createMockTranscriptAdapter()
  });
  assert.equal(host.publicState().codexAccounts.accounts.find((account) => account.id === "fresh").auth.authJson, false);
  writeFileSync(join(fresh.codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account: "fresh" } }));
  assert.equal(host.publicState().codexAccounts.accounts.find((account) => account.id === "fresh").auth.authJson, true);

  console.log("clankerbend account registry tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
