import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DIST_DIR = join(ROOT, "dist/npm");
const PACKAGE_NAMES = ["clankerbend", "@onewillai/clankerbend"];

const command = process.argv[2] || "pack";

if (!["pack", "publish"].includes(command)) {
  console.error("Usage: node scripts/release-npm.mjs pack|publish");
  process.exit(2);
}

try {
  if (command === "pack") {
    await packRelease();
  } else {
    await publishRelease();
  }
} catch (err) {
  console.error(formatReleaseError(err));
  process.exit(1);
}

async function packRelease() {
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  const basePack = await npm(["pack", "--json", "--pack-destination", DIST_DIR], ROOT);
  const base = JSON.parse(basePack.stdout)[0];
  const baseTarball = join(DIST_DIR, base.filename);
  const scopedTarball = await repackWithName(baseTarball, PACKAGE_NAMES[1]);

  console.log(JSON.stringify({
    ok: true,
    packages: [
      { name: PACKAGE_NAMES[0], tarball: baseTarball },
      { name: PACKAGE_NAMES[1], tarball: scopedTarball }
    ]
  }, null, 2));
}

async function publishRelease() {
  const args = process.argv.slice(3);
  const yes = args.includes("--yes");
  if (!yes) {
    console.error("Refusing to publish without --yes. Run `npm run release:publish -- --yes [--otp=123456]`.");
    process.exit(2);
  }
  const otp = args.find((arg) => arg.startsWith("--otp="));
  const useProvenance = args.includes("--provenance") || isKnownProvenanceCi();

  await packRelease();
  const rootPackage = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const version = rootPackage.version;
  const tarballs = [
    join(DIST_DIR, `clankerbend-${version}.tgz`),
    join(DIST_DIR, `onewillai-clankerbend-${version}.tgz`)
  ];

  await npmInteractive(
    publishArgs(tarballs[1], ["--access", "public"], { otp, useProvenance }),
    ROOT,
    { packageName: PACKAGE_NAMES[1] }
  );
  await npmInteractive(
    publishArgs(tarballs[0], [], { otp, useProvenance }),
    ROOT,
    { packageName: PACKAGE_NAMES[0] }
  );
}

function publishArgs(tarball, extraArgs, { otp, useProvenance }) {
  const args = ["publish", tarball, ...extraArgs];
  if (useProvenance) {
    args.push("--provenance");
  }
  if (otp) {
    args.push(otp);
  }
  return args;
}

function isKnownProvenanceCi() {
  return Boolean(
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI
  );
}

async function repackWithName(tarball, packageName) {
  const stageRoot = await mkdtemp(join(tmpdir(), "clankerbend-npm-release-"));
  try {
    await execFileAsync("tar", ["-xzf", tarball, "-C", stageRoot], { cwd: ROOT });
    const packageDir = join(stageRoot, "package");
    const packageJsonPath = join(packageDir, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    packageJson.name = packageName;
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    const output = await npm(["pack", packageDir, "--json", "--pack-destination", DIST_DIR], ROOT);
    const packed = JSON.parse(output.stdout)[0];
    return join(DIST_DIR, basename(packed.filename));
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

async function npm(args, cwd) {
  return execFileAsync("npm", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env
  });
}

async function npmInteractive(args, cwd, context = {}) {
  await new Promise((resolve, reject) => {
    const stderr = [];
    const child = spawn("npm", args, {
      cwd,
      env: process.env,
      stdio: ["inherit", "inherit", "pipe"]
    });
    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(releaseCommandError(args, signal || `exit code ${code}`, {
        ...context,
        stderr: Buffer.concat(stderr).toString("utf8")
      }));
    });
  });
}

function releaseCommandError(args, reason, context) {
  const err = new Error(`npm ${args.join(" ")} failed with ${reason}`);
  err.releaseCommand = true;
  err.args = args;
  err.reason = reason;
  err.stderr = context.stderr || "";
  err.packageName = context.packageName || "";
  return err;
}

function formatReleaseError(err) {
  if (err?.releaseCommand && /That word is not allowed/i.test(err.stderr || "")) {
    const packageName = err.packageName || "the package";
    const candidates = candidateNameTokens(packageName);
    return [
      "",
      `npm rejected ${packageName}: "That word is not allowed."`,
      "",
      "npm's registry response does not disclose the exact blocked token. The",
      "only package-name tokens we can identify locally are:",
      `  ${candidates.map((token) => `- ${token}`).join("\n  ")}`,
      "",
      "If npm support has unblocked the name, retry after they confirm the change",
      "has propagated. Otherwise ask support to allow this exact package id:",
      `  ${packageName}`,
      ""
    ].join("\n");
  }
  if (err?.releaseCommand) {
    return `\n${err.message}\n`;
  }
  return err?.stack || String(err);
}

function candidateNameTokens(packageName) {
  const withoutScope = packageName.replace(/^@/, "");
  const tokens = new Set(
    withoutScope
      .split(/[\/._-]+/)
      .flatMap((part) => splitCompoundName(part))
      .filter(Boolean)
  );
  return [...tokens];
}

function splitCompoundName(part) {
  const tokens = [part];
  if (part.includes("clanker")) tokens.push("clanker");
  if (part.includes("bend")) tokens.push("bend");
  if (part.includes("onewill")) tokens.push("onewill");
  if (part.includes("ai")) tokens.push("ai");
  return tokens;
}
