import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));

await main();

async function main() {
  await run("node", ["host/test-renderer-sticky-overlay.mjs"]);
  await run("npm", ["--prefix", "apps/vim-nav", "test"]);
  await run("npm", ["--prefix", "apps/sticky-notes", "test"]);
  console.log("clankerbend fast e2e suite passed");
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    console.log(`$ ${[command, ...args].join(" ")}`);
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} failed with ${signal || code}`));
    });
  });
}
