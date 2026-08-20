// dev_build_plugin 的第二步(build:client):纯 JS client,拷贝 + 特征校验。
// 与 scripts/build.sh 的 client 段保持一致(双路径都跑也幂等)。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "client", "index.js");
const out = join(root, "lib", "client.js");

mkdirSync(join(root, "lib"), { recursive: true });
const code = readFileSync(src, "utf8");
if (!code.includes("__ModuleLoader__")) {
  console.error("src/client/index.js 缺 __ModuleLoader__ 特征");
  process.exit(1);
}
writeFileSync(out, code);
console.log("client ✓ (src/client/index.js → lib/client.js)");
