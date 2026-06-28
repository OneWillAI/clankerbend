import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchClankerBendCodex } from "../../server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

await launchClankerBendCodex({
  mock: process.argv.includes("--mock"),
  runDir: join(__dirname, "run")
});
