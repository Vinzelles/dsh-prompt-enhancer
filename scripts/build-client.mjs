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
if (!code.includes("configForms")) {
  console.error("src/client/index.js 缺 configForms(0.2.x 设置表单服务)");
  process.exit(1);
}
writeFileSync(out, code);
console.log("client ✓ (src/client/index.js → lib/client.js)");

// 0.2.x 起 host 侧多了 config.js(官方 Config 通道),它与 client 同为纯 JS,
// 这里一并拷一遍,保证只跑 build:client 的路径也能得到完整产物。
const configSrc = join(root, "src", "config.js");
const configOut = join(root, "lib", "config.js");
const configCode = readFileSync(configSrc, "utf8");
if (!configCode.includes("export const Config")) {
  console.error("src/config.js 缺 Config 导出");
  process.exit(1);
}
writeFileSync(configOut, configCode);
console.log("config ✓ (src/config.js → lib/config.js)");
