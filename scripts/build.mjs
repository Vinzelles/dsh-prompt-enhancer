// @dsh-external/dsh-prompt-enhancer — 纯 JS 插件构建(无 tsc/tsdown 依赖)。
// 本环境无源码 checkout、无 tsdown:host/client/config 均为手写 JS,构建即拷贝 + 特征校验。
// 这是 scripts/build.sh 的跨平台等价物:Windows 上 bash 可能是未装发行版的 WSL 桩,
// 而 npm run build 必须到处都能跑,所以用 node 实现同一件事。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "lib"), { recursive: true });

/** 拷贝 src/<rel> → lib/<rel>,并断言产物至少含有这些特征串。 */
function emit(source, target, markers) {
  const from = join(root, "src", source);
  const to = join(root, "lib", target);
  const code = readFileSync(from, "utf8");
  for (const [needle, message] of markers) {
    if (!code.includes(needle)) {
      console.error(`src/${source} ${message}`);
      process.exit(1);
    }
  }
  copyFileSync(from, to);
  console.log(`${target} ✓ (src/${source} → lib/${target})`);
  return code;
}

const host = emit("index.js", "index.js", [
  ["export function apply", "缺 apply 导出"],
  ["./config.js", "未引用 ./config.js(0.2.x 官方 Config 通道缺失)"],
]);

emit("config.js", "config.js", [
  ["export const Config", "缺 Config 导出(宿主 SettingsForms 读不到表单)"],
  ["export function readEnhancerConfig", "缺 readEnhancerConfig 导出"],
]);

emit("client/index.js", "client.js", [
  ["__ModuleLoader__", "缺 __ModuleLoader__ 特征(注入器校验必挂)"],
  ["configForms", "缺 configForms(0.2.x 设置表单服务)"],
]);

// apply 的第二参必须是 config,否则宿主校验后的配置到不了绑定函数。
if (!/export function apply\(\s*ctx\s*,\s*config\s*\)/.test(host)) {
  console.error("lib/index.js 的 apply 未接收第二参 config(cordis 0.2.x 配置通道)");
  process.exit(1);
}

console.log("=== Build complete ===");
