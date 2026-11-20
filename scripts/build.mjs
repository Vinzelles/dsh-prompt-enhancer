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
  ["enhanceWithLlm", "缺通道 A 直调"],
  ["catalogProviderInfos", "缺模型目录合并"],
  ['const channel = "llm"', "强化入口未固定通道 A"],
]);
const handleRoute = host.slice(host.indexOf("async function handleRoute"), host.indexOf("async function suggestNext"));
if (handleRoute.includes("enhanceWithChildAgent")) {
  console.error("src/index.js handleRoute 仍调用 enhanceWithChildAgent");
  process.exit(1);
}

emit("config.js", "config.js", [
  ["export const Config", "缺 Config 导出(宿主 SettingsForms 读不到表单)"],
  ["export function readEnhancerConfig", "缺 readEnhancerConfig 导出"],
]);

emit("client/index.js", "client.js", [
  ["__ModuleLoader__", "缺 __ModuleLoader__ 特征(注入器校验必挂)"],
  ["configForms", "缺 configForms(0.2.x 设置表单服务)"],
  ["modelDirectories", "缺 modelDirectories(Codex 冲突判定读不到当前模型)"],
  ["defaultPrevented", "Tab 未避开已被其他插件处理的按键"],
  ["suggestionConsumed", "缺已消费建议判定"],
  ["catalogGroupsFromRemote", "缺宿主 modelCatalog 载荷解析"],
  ["llm/adapters-updated", "设置卡片未订阅宿主模型目录刷新"],
  ["CLIENT_TIMEOUT_MS = 70000", "客户端超时未改为通道 A 预算"],
]);
const clientCode = readFileSync(join(root, "src", "client", "index.js"), "utf8");
if (clientCode.includes("remote.session") || clientCode.includes("remote?.session")) {
  console.error("src/client/index.js 设置卡片不得访问 remote.session");
  process.exit(1);
}

// apply 的第二参必须是 config,否则宿主校验后的配置到不了绑定函数。
if (!/export function apply\(\s*ctx\s*,\s*config\s*\)/.test(host)) {
  console.error("lib/index.js 的 apply 未接收第二参 config(cordis 0.2.x 配置通道)");
  process.exit(1);
}

console.log("=== Build complete ===");
