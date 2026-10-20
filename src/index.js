/**
 * @dsh-external/dsh-prompt-enhancer — host 端(纯 JS,ESM)。
 *
 * 提示词增强插件:输入框「强化」按钮触发 POST /prompt-enhancer,
 * 服务端结合有界对话窗口 + 会话工作目录(仓库知识),把原始提示词
 * 重写为结构化的 agent 任务提示词并附参考文件清单。
 *
 * 执行通道(ADR-0001,2026-08-21 修订:通道 B 二级降级):
 *   通道 B(主):隔离子会话 agent(composeFrom 继承父会话预设组合 + 只读工具限制 +
 *              强化专用 persona),完整 agent 循环,结果回传后 dispose,不污染主对话历史。
 *              父预设若携带与全新子会话首轮不兼容的机制(如 router 预设 bootstrap
 *              要求平台 shell 在目录中,而只读限制已将其移除→首轮 turn 错误无文本),
 *              退化为不 join 预设的裸子会话重试一次(纯改写、无文件检索)。
 *   通道 A(降级):ctx.llm.stream 直调,同一 persona 与 payload。
 *
 * 决策基线(grill 会话共识,详见 CONTEXT.md):
 *   窗口 ~8k token(24000 字符预算)/ 参考文件 top-5 / 摘录 ≤2 篇 × ≤20 行 /
 *   通道 B 超时 90s / 通道 A 超时 60s / 保持输入语言(或「转换英文」开关开启时
 *   统一英文输出)/ 软长度约原文 2 倍。
 *
 * Skill 引用保留(2026-08-22):原始提示词中的 `/skill-name` 记号是宿主技能
 * 引用语法(dsh-tool-skill 以 SKILL_GESTURE 全文扫描用户消息后注入技能全文),
 * 强化必须原样保留。三层保障:① 提取(与宿主同文法)随 payload 下发;
 * ② persona 规则 9 + payload【Skill 引用】节约束改写;③ 输出缺失记号时以
 * 「## 技能引用」节确定性回填(宿主全文扫描照样命中)。
 */

const ENDPOINT = "/prompt-enhancer";
const MODELS_ENDPOINT = "/prompt-enhancer/models";
const DIAG_ENDPOINT = "/prompt-enhancer/diag";
const CHILD_TIMEOUT_MS = 90_000;
const FALLBACK_TIMEOUT_MS = 60_000;
const CONTEXT_CHAR_BUDGET = 24_000; // ≈8k token 混合中英
const CONTEXT_LINE_CAP = 3_000; // 单条消息折叠上限,防单条巨长消息独占窗口
const READONLY_TOOLS = ["glob", "grep", "read"];
/** Skill 引用记号文法(与宿主 dsh-tool-skill 的 SKILL_GESTURE 逐字符一致):
 *  行首或空白后的 /name,name 限 kebab-case,后随空白/行尾。宿主据此识别
 *  用户消息中的技能引用并在对话中注入技能全文;强化必须原样保留这些记号。 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

/** 草稿长度上限:超长(如整文件/大日志粘贴)请求立即 400 拒绝,
 *  防止上下文窗口与请求体积失控。 */
const MAX_DRAFT_CHARS = 200_000;

/** 草稿超限时返回 400 错误信息,否则 null(纯函数:单测)。 */
function draftLimitError(draft) {
  return draft.length > MAX_DRAFT_CHARS ? "草稿超过长度上限(" + MAX_DRAFT_CHARS + " 字符)" : null;
}

import { appendFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Config, CONFIG_KEYS, readEnhancerConfig } from "./config.js";

/** 设置面板的官方入口(dsh 0.2.x):由 config.js 导出的 schemastery Config 决定。
 *  宿主 SettingsForms.describe() 直接读 `entry.fiber.runtime.Config`,没有注册 API。 */
export { Config, CONFIG_KEYS };

const DIAG_FILE = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "super-injector", "prompt-enhancer-diag.log");

/* ═══════════════ 第三方依赖加载 ═══════════════
 * 0.2.x 起设置面板走官方 Config 通道(见 config.js),插件不再需要自己 import
 * schemastery 造 schema;下面这段只服务 subagent/descriptor 契约版本探测
 * (要读宿主 dsh-subagent 的真实常量)。
 * 本插件部署在 vendor 目录(无 node_modules),所以用「定位包目录 + 绝对 file URL
 * 运行时 import」而不是静态裸 import:dsh-subagent 物理位于宿主依赖树内,
 * 其自身依赖从它所在目录的 node_modules 树解析,天然成功。 */

/** 探测宿主依赖树中 @deepseek-ai 包的实际目录(2026-08-20 消失事件后重构:
 *  profile pnpm 重装后顶层 node_modules 不再挂传递依赖——dsh-settings 退化为
 *  dshmarket 的传递依赖,只在 .pnpm 虚拟存储里;desktop 部署的官方依赖树
 *  位于 desktop 安装目录下,DSH_HOME=~/.dsh 时从 home 向上探测也够不着)。
 *  候选根按优先级:
 *  ① {DSH_HOME}/profiles/{web,default}/node_modules(注入插件 junction 层/旧标准布局)
 *  ② {DSH_HOME}/node_modules、{DSH_HOME}/dependencies/dsh/node_modules
 *  ③ 自 DSH_HOME 逐级向上 …/dependencies/dsh/node_modules(DSH_HOME 位于
 *     desktop 安装目录内时命中官方依赖树)
 *  ④ 基于本模块位置逐级向上 …/node_modules(junction 指向源码目录时兜底)
 *  ⑤ Windows desktop 官方依赖树(宿主自其依赖树启动时的物理位置)。
 *  每层先查顶层 <root>/<pkg>,再查 pnpm 虚拟存储
 *  <root>/.pnpm/<pkg 编码>@<ver>/node_modules/<pkg>,返回第一个含 package.json 的命中。 */
function findPackageDir(pkg) {
  const seen = new Set();
  const roots = [];
  const add = (nm) => {
    if (!nm || seen.has(nm)) return;
    seen.add(nm);
    roots.push(nm);
  };
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  // ① profile node_modules(旧标准布局 + 注入器 junction 层)
  for (const name of ["web", "default"]) add(join(home, "profiles", name, "node_modules"));
  // ② DSH_HOME 自身可能的依赖位置
  add(join(home, "node_modules"));
  add(join(home, "dependencies", "dsh", "node_modules"));
  // ③ desktop 布局:从 DSH_HOME 逐级向上,每级检查 dependencies/dsh/node_modules
  //    (DSH_HOME=…/data/dsh 时,命中 …/dependencies/dsh/node_modules)
  for (let dir = home; ; ) {
    add(join(dir, "dependencies", "dsh", "node_modules"));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // ④ 基于本模块位置的向上探测(junction realpath 后到源码目录,源码树内无依赖时兜底)
  //    以及「托管包自带依赖图」优先位:部署到 node_modules 下的副本会带精确依赖。
  const here = dirname(fileURLToPath(import.meta.url));
  add(resolve(here, "..", "node_modules"));
  for (let dir = here; ; ) {
    add(join(dir, "node_modules"));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // ⑤ 宿主进程自身的安装位置(最可靠的运行时事实):宿主 bin 在
  //    <install>/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js,
  //    从 argv[1] 逐级向上即可覆盖任何发行版目录命名。
  const argvEntry = process.argv?.[1];
  if (typeof argvEntry === "string" && argvEntry !== "") {
    for (let dir = dirname(argvEntry); ; ) {
      add(join(dir, "node_modules"));
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  // ⑥ Windows desktop 官方依赖树:desktop 外壳的 app-dir 名随发行版变化
  //    (dsh-tauri / io.github.hairyf.deepseek-harness-desktop / ...),因此遍历
  //    AppData\Roaming 下带 dependencies\dsh\node_modules 的目录,不硬编码名字。
  if (process.platform === "win32") {
    const roaming = join(homedir(), "AppData", "Roaming");
    try {
      for (const entry of readdirSync(roaming)) {
        add(join(roaming, entry, "dependencies", "dsh", "node_modules"));
      }
    } catch { /* AppData 不可读:跳过 */ }
    add(join(roaming, "io.github.hairyf.deepseek-harness-desktop", "dependencies", "dsh", "node_modules"));
  }
  const enc = pkg.replace("/", "+");
  for (const nm of roots) {
    const direct = join(nm, pkg);
    if (existsSync(join(direct, "package.json"))) return direct;
    const store = join(nm, ".pnpm");
    if (existsSync(store)) {
      let storeDirs = [];
      try {
        storeDirs = readdirSync(store);
      } catch {
        continue;
      }
      for (const d of storeDirs) {
        if (!d.startsWith(enc + "@")) continue;
        const p = join(store, d, "node_modules", pkg);
        if (existsSync(join(p, "package.json"))) return p;
      }
    }
  }
  return undefined;
}

const SUBAGENT_PKG_DIR = findPackageDir("@deepseek-ai/dsh-subagent");

/* ═══════════════ subagent/descriptor 版本契约(宿主联动,兼容 0.1.1 过渡期) ═══════════════
 * 宿主 0.1.2 起 SUBAGENT_DESCRIPTOR_VERSION 从 2 升到 3(0.1.0-rc.8~0.1.1-rc.2 = 2;
 * 0.1.2-alpha.2 起 = 3,均经 npm 发布物实证),且 dsh-subagent 的 foldSubagentDescriptor
 * 对「版本不等于当前值」的 payload 一律返回 undefined → 子会话身份投影折叠为 null →
 * 子代理目录(list-children)把该子会话判为 diagnostic/corrupt → UI 显示「会话记录损坏」。
 * 硬编码任何版本号都会让另一代宿主踩坑(写 3 则 0.1.1 损坏,写 2 则 0.1.2 损坏),
 * 因此模块加载时按三级通道解析宿主真实契约:
 *   ① import 宿主 dsh-subagent 的 lib/types/descriptor.js 读 SUBAGENT_DESCRIPTOR_VERSION
 *      (与宿主同一份运行时事实,profile 树里残留的旧版 dsh-subagent 不会误导);
 *   ② 裸 import 失败(如宿主包自身依赖解析异常)→ 读同一文件正则扫描常量;
 *   ③ 常量不可见(如宿主改版挪走文件/常量名)→ 按 dsh-subagent 包 semver 推断:
 *      < 0.1.2 → 2,≥ 0.1.2 → 3(即上方实证边界 descriptorVersionFromPackageJson)。
 * 三级全失败(宿主包整体定位不到——此时无子代理目录折叠,descriptor 版本无真实消费方)
 * 才用最终兜底 3(最新契约),并落盘信标。one-shot 字段集(version/mode/provider/label)
 * 在 v2/v3 逐字相同(2026-09-07 比对 0.1.1-rc.2 与 0.1.2-rc.1 的 DESCRIPTOR_BASE_KEYS),
 * 故只需随解析版本 stamp 数字;若未来宿主改版新增必填字段,需要插件同步调整 payload 形态。
 * 0.1.1 兼容为过渡支持(README「宿主兼容」),后续版本将逐渐弃用。 */
function scanDescriptorVersionFromFile(pkgDir) {
  try {
    const text = readFileSync(join(pkgDir, "lib", "types", "descriptor.js"), "utf8");
    const match = /SUBAGENT_DESCRIPTOR_VERSION\s*=\s*(\d+)/.exec(text);
    const v = match === null ? NaN : Number(match[1]);
    return Number.isInteger(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 通道③:按宿主 dsh-subagent 包自身 semver 推断契约版本(实证边界 0.1.2)。
 *  0.x 且 (minor < 1 || (minor === 1 && patch < 2)) → 2;其余(0.1.2+/0.2+/1+) → 3。
 *  版本号不可解析 → undefined(交给调用方最终兜底)。 */
function descriptorVersionFromPackageJson(pkgDir) {
  try {
    const raw = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(raw?.version ?? ""));
    if (match === null) return undefined;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (major > 0) return 3;
    if (minor > 1 || (minor === 1 && patch >= 2)) return 3;
    return 2;
  } catch {
    return undefined;
  }
}

/** 三级解析宿主 descriptor 契约版本;importModule 注入以便单测。
 *  返回 { version, channel } 或 undefined(全通道失败)。 */
async function resolveDescriptorVersion(pkgDir, importModule) {
  try {
    const descriptorEntry = pathToFileURL(join(pkgDir, "lib", "types", "descriptor.js")).href;
    const mod = await importModule(descriptorEntry);
    const v = mod?.SUBAGENT_DESCRIPTOR_VERSION;
    if (Number.isInteger(v) && v > 0) return { version: v, channel: "import" };
  } catch { /* 通道② 继续 */ }
  const scanned = scanDescriptorVersionFromFile(pkgDir);
  if (scanned !== undefined) return { version: scanned, channel: "scan" };
  const inferred = descriptorVersionFromPackageJson(pkgDir);
  if (inferred !== undefined) return { version: inferred, channel: "package-version" };
  return undefined;
}

let descriptorVersion;
let descriptorVersionChannel = "pin-latest";
try {
  const subagentPkgDir = SUBAGENT_PKG_DIR;
  if (subagentPkgDir !== undefined) {
    const resolved = await resolveDescriptorVersion(subagentPkgDir, (url) => import(url));
    if (resolved !== undefined) {
      descriptorVersion = resolved.version;
      descriptorVersionChannel = resolved.channel;
    }
  }
} catch (error) {
  try { diagLog("descriptor-version-resolve-error", { message: String(error?.message ?? error) }); } catch {}
}
if (descriptorVersion === undefined) descriptorVersion = 3;
try {
  if (descriptorVersionChannel === "pin-latest") {
    // 三级通道全失败才 pin:将来宿主换常量时会静默变 corrupt,必须留痕(与 ADR-0004 残留风险对应)
    console.warn("[dsh-prompt-enhancer] 未能解析宿主 subagent/descriptor 契约版本,已 pin 3——若该宿主常量不同,强化子会话会被判「会话记录损坏」");
  }
  diagLog("descriptor-version-resolved", { version: descriptorVersion, channel: descriptorVersionChannel });
} catch {}

/* ═══════════════ 用户设置(生效值源) ═══════════════
 * dsh 0.2.x 的 settings seam 只有一条官方通道(0.1.x 的三种注册 API 已全部移除,
 * 全宿主 grep installSection 零命中):
 *   插件的 `export const Config`(schemastery schema,见 config.js)
 *   → 宿主 SettingsForms.describe() 读 entry.fiber.runtime.Config 投影成表单
 *   → 客户端 ctx.configForms.get(entryId) 渲染卡片并 set/unset 字段
 *   → cordis 把新值写进 volatile 引用,不重启插件 → 本插件每次请求 ref.get() 即时生效。
 * 因此这里不再注册任何 schema:hooks 形态的 installSection 已经不存在了。 */

const SETTINGS_NS = "prompt-enhancer";
const SETTINGS_DEFAULTS = { intensity: "medium", outputEnglish: false };

/** 每个插件实例(apply 的 ctx)自己的配置源。
 *  volatile 字段必须每次重新读 ref,用户改设置才会即时生效;用 WeakMap 而不是
 *  模块级变量,避免同一进程内多 profile/多次 apply 时互相串味。 */
const profileConfigSources = new WeakMap();

/** 读取当前生效配置(每次请求时调用,保证用户改设置即时生效)。
 *  config 缺失(旧宿主 / 未声明 Config)时退回 SETTINGS_DEFAULTS。 */
function enhanceConfig(ctx) {
  const source = profileConfigSources.get(ctx);
  let value = SETTINGS_DEFAULTS;
  if (typeof source === "function") {
    try {
      value = source() ?? SETTINGS_DEFAULTS;
    } catch (error) {
      diagLog("config-read-error", { message: String(error?.message ?? error) });
      value = SETTINGS_DEFAULTS;
    }
  }
  const intensity = value.intensity === "low" || value.intensity === "high" ? value.intensity : "medium";
  const outputEnglish = value.outputEnglish === true;
  const modelValue = value.model;
  const model =
    modelValue !== null && typeof modelValue === "object" &&
    typeof modelValue.provider === "string" && modelValue.provider !== "" &&
    typeof modelValue.model === "string" && modelValue.model !== ""
      ? {
          provider: modelValue.provider,
          model: modelValue.model,
          reasoningEffort:
            typeof modelValue.reasoningEffort === "string" && modelValue.reasoningEffort !== ""
              ? modelValue.reasoningEffort
              : undefined,
        }
      : undefined;
  return { intensity, model, outputEnglish };
}

function diagLog(stage, detail) {
  try {
    mkdirSync(dirname(DIAG_FILE), { recursive: true });
    appendFileSync(DIAG_FILE, "[" + new Date().toISOString() + "] " + stage + " " + JSON.stringify(detail ?? {}) + "\n");
  } catch { /* 诊断日志失败静默 */ }
}

/** 强化专用 persona:子会话系统段(遮蔽父 persona)与通道 A 的 system 共用。
 *  outputEnglish=true(设置「转换英文」开关开启)时切换输出语言规则:
 *  结果一律英文书写,参考文件节/技能引用节标题随之英文化;skill 记号、路径与
 *  专有名词仍原样保留(宿主校验与全文扫描依赖原文记号,翻译即失效)。 */
function enhancerPersona(outputEnglish) {
  const refsHeading = outputEnglish ? "## Reference Files" : "## 参考文件";
  const skillHeading = outputEnglish ? "## Skill References" : "## 技能引用";
  const refsLine = outputEnglish
    ? "每行「- 相对路径 — a one-line relevance note」(相关性说明用英文)。"
    : "每行「- 相对路径 — 一句话相关性说明」。";
  return [
    "你是「提示词增强器」(Prompt Enhancer)。唯一任务:把用户提交的一条原始提示词改写为结构清晰、约束明确、可直接交给 AI 编程 agent 执行的任务提示词,并在末尾附上参考文件清单。",
    "规则:",
    outputEnglish
      ? "1. 输出语言:无论原始提示词是什么语言,强化结果一律使用英文书写;忠实传达用户真实需求的语义,不得因语言转换新增、删除或弱化需求;代码标识符、文件路径、专有名词与 /skill-name 记号保持原样,不得翻译。"
      : "1. 保持用户输入的语言(中文进中文出、英文进英文出),禁止翻译。",
    "2. 不改变用户真实意图:不得新增用户没要求的功能,不得删除或弱化用户已提出的需求;可对需求做澄清性展开(目标/背景/步骤/约束/验收),并追加最少必要的工作指令(如「先阅读参考文件再动手」)。",
    outputEnglish
      ? "3. 结构建议(按需选用,不要机械套用,全部用英文书写):Goal / Context (if any) / Steps / Constraints / Acceptance criteria."
      : "3. 结构建议(按需选用,不要机械套用):目标 / 背景(如有) / 步骤 / 约束 / 验收标准。",
    "4. 长度软约束:通常不超过原文的 2 倍;不要为凑结构注水。",
    "5. 仓库知识:若当前工作目录存在,用 glob/grep/read 等只读工具基于原始提示词的关键词,有界地定位 ≤5 个最相关文件(优先 README、docs、架构说明、规则文件,其次直接相关的源码);不要遍历全仓。",
    "6. 参考文件清单:在输出末尾加「" + refsHeading + "」一节," + refsLine + "只列你实际用 glob/grep/read 打开并确认存在的文件,禁止臆测或猜测路径(宿主会自动校验并剔除不存在的路径);未找到相关文件或没有工作目录时省略该节。",
    "7. 摘录:最多对 2 个「高相关且短」的文件在清单后附 ≤20 行关键摘录;其余文件只给路径与说明。",
    "8. 输出格式:只输出改写后的提示词本身(含参考文件节);禁止输出任何解释、前言、确认语或代码围栏。",
    "9. Skill引用:原始提示词中的 /skill-name 形式记号是宿主平台的技能(skill)调用语法,发送后由宿主识别并注入技能全文——它们不是普通文字。必须原样保留原始提示词中的每一个这类记号(连斜杠一起逐字符照抄,可融入正文或集中放在「" + skillHeading + "」节);禁止翻译、禁止改写成描述性词语(如把 /tdd 写成「TDD 流程」)、禁止加代码围栏、禁止删除。",
    "10. 意图先行:先判断原始提示词的意图类别再组织输出,不机械套用固定模板——排查类(为什么/异常):运行环境与上下文→实际现象→预期行为→需重点核查的方向→要求根本原因与可执行修复步骤;实现类(帮我做/加/改):目标与交付物→技术栈与约束→执行步骤→验收标准;解释/方案类:话题范围与目标读者→需覆盖的维度→依据、例子或对比;简单问答/闲聊:保留原长,只做必要澄清,不过度膨胀。不发明事实:缺关键背景时写成「结合项目代码/日志确认……」由执行者自行核实;一句话含多个问题时拆成编号子问题;原话已完整清晰时只做最小必要改写,不要为改而改。",
  ].join("\n");
}

export const name = "@dsh-external/dsh-prompt-enhancer";
export const inject = ["sessions", "agents", "llm", "webServer", "workspaceRegistry", "sessionQuery"];

/** 装配本实例的配置源(0.2.x:apply 第二参 = cordis 用 Config 校验后的配置)。
 *  volatile 字段是引用对象,必须每次 get() 才能拿到用户当前值;引用对象本身不变,
 *  所以这里只需闭包持有 config,不必订阅任何事件。
 *  旧宿主(无 Config 通道)保持 SETTINGS_DEFAULTS。 */
function bindConfigSource(ctx, config) {
  if (config === null || typeof config !== "object") return;
  const first = CONFIG_KEYS.some((key) => Reflect.get(config, key) !== undefined);
  if (!first) return;
  profileConfigSources.set(ctx, () => readEnhancerConfig(config));
  try {
    diagLog("config-bound", { ns: SETTINGS_NS, keys: Object.keys(config) });
  } catch {}
}

export function apply(ctx, config) {
  // 0.2.x 官方配置通道:本实例的生效值源(用户改设置即时生效,无需重启插件)
  bindConfigSource(ctx, config);
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ENDPOINT,
    handler: (request, response) => handleRoute(ctx, request, response),
  }), "dsh-prompt-enhancer: HTTP route");
  // 模型目录(设置卡片「强化模型」下拉的数据源)
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: MODELS_ENDPOINT,
    handler: (request, response) => handleModels(ctx, request, response),
  }), "dsh-prompt-enhancer: models route");
  // 诊断信标:客户端各执行阶段回传,落盘供排障(临时埋点,稳定后可移除)
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: DIAG_ENDPOINT,
handler: (request, response) => {
      if (!isLoopbackRequest(request)) {
        rejectForeign(request, response);
        return;
      }
      requestJson(request).then((body) => {
        diagLog(String(body.stage ?? "unknown"), { ua: String(request.headers?.["user-agent"] ?? "").slice(0, 80), detail: body.detail });
        respondJson(response, 200, { ok: true });
      }).catch((error) => {
        respondJson(response, 400, { error: String(error) });
      });
    },
  }), "dsh-prompt-enhancer: diag route");
  ctx.logger?.info("[dsh-prompt-enhancer] 强化端点已注册: POST " + ENDPOINT);
}

/* ═══════════════ HTTP ═══════════════ */

/** 回环来源白名单(fail-closed:其余地址——含缺失 socket——一律拒绝)。
 *  DSH web 服务经局域网/隧道/反代暴露时(远程使用常见),三端点不得被非本机
 *  来源触达:enhance 端点可借任意 sessionId 触发子代理在用户仓库做检索并
 *  消耗 LLM 额度;diag/models 泄漏本机信息。非本机来源 → 403 立即拒绝。 */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** 请求是否来自本机回环(纯函数:仅看 socket.remoteAddress,便于单测)。 */
function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress;
  return typeof address === "string" && LOOPBACK_ADDRESSES.has(address);
}

/** 统一访问控制闸:非本机来源 → 403(不返回业务错误信息),落盘信标供取证。 */
function rejectForeign(request, response) {
  const address = request?.socket?.remoteAddress;
  diagLog("foreign-request-rejected", {
    address: typeof address === "string" ? address : "unknown",
    method: typeof request?.method === "string" ? request.method : "?",
  });
  respondJson(response, 403, { error: "Forbidden" });
}

async function handleRoute(ctx, request, response) {
  if (!isLoopbackRequest(request)) {
    rejectForeign(request, response);
    return;
  }
  // 客户端取消联动:客户端真正断开 = 响应连接关闭且未写完,或请求上传中止。
  // 注意不能用 request.on("close"):请求体读完后正常也会触发(误判)。
  const aborted = new AbortController();
  const onAbort = () => {
    if (!response.writableEnded) aborted.abort(new Error("客户端已断开"));
  };
  response.on("close", onAbort);
  request.on("aborted", onAbort);
  try {
    if (request.method !== "POST") {
      respondJson(response, 405, { error: "仅支持 POST" });
      return;
    }
    const body = await requestJson(request);
    const sessionId = typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : null;
    const draft = typeof body.draft === "string" ? body.draft : "";
    const clientCwd = typeof body.cwd === "string" && body.cwd !== "" ? body.cwd : undefined;
    if (sessionId === null || draft.trim() === "") {
      respondJson(response, 400, { error: "sessionId 与 draft 为必填项" });
      return;
    }
    // 草稿长度上限(超限不发起 LLM 调用)
    const limitError = draftLimitError(draft);
    if (limitError !== null) {
      diagLog("enhance-draft-too-long", { sessionId, draftLength: draft.length, limit: MAX_DRAFT_CHARS });
      respondJson(response, 400, { error: limitError });
      return;
    }
    // Skill 引用提取(与宿主同文法):供 payload 约束与输出兜底校验
    const referencedSkills = extractSkillNames(draft);
    if (referencedSkills.length > 0) diagLog("skill-refs-extracted", { sessionId, skills: referencedSkills });
    const source = await readSource(ctx, sessionId);
    const route = await routeOf(ctx, sessionId, source.events);
    const resolved = cwdOf(ctx, sessionId, source.events, clientCwd);
    const cwd = resolved.cwd;
    const cfg = enhanceConfig(ctx);
    diagLog("enhance-start", {
      sessionId,
      cwd: cwd ?? null,
      cwdSource: resolved.source,
      clientCwd: clientCwd ?? null,
      draftLength: draft.length,
      intensity: cfg.intensity,
      outputEnglish: cfg.outputEnglish,
      model: cfg.model ?? null,
    });
    const context = boundedContext(source.events);
    const payload = buildPayload(draft, context, cwd, cfg.intensity, referencedSkills, cfg.outputEnglish);
    const persona = enhancerPersona(cfg.outputEnglish);

    // 截断标记:两通道输出都可能被 maxTokens 截断;截断时 UI 显式告警
    // (草稿仍替换、还原入口可用)——截断损坏的提示词不得静默覆盖输入框
    let truncated = false;
    let channel = "child";
    let enhanced;
    try {
      const result = await enhanceWithChildAgent(ctx, route, cwd, payload, sessionId, aborted.signal, cfg.model, persona);
      enhanced = result.text;
      truncated = result.truncated === true;
    } catch (error) {
      if (aborted.signal.aborted) {
        diagLog("enhance-aborted", { sessionId });
        return; // 客户端已离开,响应无意义,不降级
      }
      diagLog("enhance-channel-b-failed", {
        sessionId,
        message: String(error?.message ?? error),
        stack: String(error?.stack ?? "").slice(0, 800),
      });
      ctx.logger?.warn("[dsh-prompt-enhancer] 通道 B(子会话)失败,降级通道 A(llm 直调): " + String(error));
      channel = "llm";
      const result = await enhanceWithLlm(ctx, route, payload, aborted.signal, cfg.model, persona);
      enhanced = result.text;
      truncated = result.truncated === true;
    }
    // 防臆造路径:参考清单逐行校验存在性
    const sanitized = sanitizeReferences(enhanced, cwd);
    if (sanitized.removed > 0) {
      diagLog("enhance-refs-sanitized", { sessionId, removed: sanitized.removed, cwd: cwd ?? null });
      enhanced = sanitized.text;
    }
    // Skill 引用兜底:输出丢失记号时确定性回填「## 技能引用」节(英文模式为「## Skill References」)
    if (referencedSkills.length > 0) {
      const restored = ensureSkillReferences(enhanced, referencedSkills, cfg.outputEnglish);
      if (restored.added > 0) {
        diagLog("enhance-skills-restored", { sessionId, requested: restored.requested, added: restored.added, mode: restored.mode });
        enhanced = restored.text;
      }
    }
    const beforeIntensity = enhanced;
    // 低档强度:即使模型不听话也强制去掉文件引用
    if (cfg.intensity === "low") {
      enhanced = stripReferences(enhanced);
      diagLog("enhance-intensity-low", { sessionId, stripped: enhanced !== beforeIntensity });
    } else if (cfg.intensity === "medium") {
      // 中档强度:即使模型不听话也强制压缩参考节(只留路径、去说明与摘录)
      const compacted = compactMediumReferences(enhanced);
      diagLog("enhance-intensity-medium", { sessionId, compacted: compacted !== beforeIntensity });
      enhanced = compacted;
    }
    if (truncated) diagLog("enhance-truncated", { sessionId, channel, draftLength: draft.length });
    respondJson(response, 200, { enhanced, ...(truncated ? { truncated: true } : {}) });
  } catch (error) {
    if (aborted.signal.aborted) return; // 客户端已断开,静默
    const message = error instanceof Error ? error.message : String(error);
    respondJson(response, error instanceof TypeError ? 400 : 502, { error: message });
  } finally {
    request.off("aborted", onAbort);
    response.off("close", onAbort);
  }
}

function requestJson(request) {
  return new Promise((resolve, reject) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new TypeError("请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function respondJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

/* ═══════════════ 模型目录(设置卡片数据源) ═══════════════ */

/** GET /prompt-enhancer/models:枚举已配置 provider 及其模型(含思考强度目录)。
 *  形状与 dsh-host-apiproxy 的 buildModelCatalog 一致,便于 client 直接消费。 */
async function handleModels(ctx, request, response) {
  if (!isLoopbackRequest(request)) {
    rejectForeign(request, response);
    return;
  }
  try {
    if (request.method !== "GET") {
      respondJson(response, 405, { error: "仅支持 GET" });
      return;
    }
    const providers = typeof ctx.llm?.listProviders === "function" ? ctx.llm.listProviders() : [];
    const catalog = await Promise.all(providers.map(async (provider) => {
      try {
        const models = await ctx.llm.listModels(provider.id);
        const entries = await Promise.all(models.map(async (model) => {
          const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);
          const reasoning =
            resolved?.reasoning === undefined
              ? undefined
              : {
                  efforts: resolved.reasoning.efforts.map((effort) => ({
                    id: effort.id,
                    name: effort.name,
                    ...(effort.description === undefined ? {} : { description: effort.description }),
                  })),
                  ...(resolved.reasoning.defaultEffort === undefined ? {} : { defaultEffort: resolved.reasoning.defaultEffort }),
                };
          return {
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            ...(reasoning === undefined ? {} : { reasoning }),
          };
        }));
        return { kind: "group", group: { id: provider.id, name: provider.name, models: entries } };
      } catch (error) {
        return {
          kind: "failure",
          failure: { id: provider.id, name: provider.name, message: error instanceof Error ? error.message : String(error) },
        };
      }
    }));
    const groups = catalog
      .filter((item) => item.kind === "group")
      .map((item) => item.group)
      .filter((group) => group.models.length > 0);
    const failures = catalog.filter((item) => item.kind === "failure").map((item) => item.failure);
    respondJson(response, 200, { groups, failures });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respondJson(response, 502, { error: message });
  }
}

function truncateJson(value, cap) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (typeof text !== "string") return text;
  return text.length > cap ? text.slice(0, cap) + "…(truncated)" : text;
}

/* ═══════════════ 会话读取 ═══════════════ */

/** 活会话优先,否则经 sessionQuery 读持久化记录(与 dsh-message-edit readCurrentLog 同法)。 */
async function readSource(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId);
  if (live !== undefined && Array.isArray(live.events)) {
    return { events: live.events, header: live.header };
  }
  const record = await ctx.sessionQuery.readSession(sessionId);
  return { events: record?.events ?? [], header: record?.header };
}

/** 模型路由:活父 agent 的 options 优先,退回会话 request/header 事件(与 message-edit agentOptions 同法)。
 *  显式解析 adapter 声明的 defaultEffort:部署默认(settings 的 medium)可能不被某些 provider 目录支持,
 *  显式传 adapter 认可的 effort 让 prepareCall 校验稳定通过。 */
async function routeOf(ctx, sessionId, events) {
  const parent = ctx.agents.get(sessionId);
  const provider = parent?.options?.provider ?? headerOf(events)?.config?.provider;
  const model = parent?.options?.model ?? headerOf(events)?.config?.model;
  const maxTokens = parent?.options?.maxTokens ?? headerOf(events)?.config?.maxTokens;
  if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") {
    throw new Error("无法解析当前会话的模型路由(request/header 缺失)");
  }
  const route = {
    provider,
    model,
    maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : undefined,
  };
  // 会话 header 里已有的 effort 优先(用户在该会话的选择),但必须落在 adapter 支持集合内;
  // 否则退回 adapter 默认(保证 prepareCall 校验通过)。解析失败不阻断。
  const headerEffort = headerOf(events)?.config?.reasoningEffort;
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model);
    const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : [];
    const defaultEffort = info?.reasoning?.defaultEffort;
    if (typeof headerEffort === "string" && headerEffort !== "" && efforts.some((e) => e?.id === headerEffort)) {
      route.reasoningEffort = headerEffort;
    } else if (typeof defaultEffort === "string" && defaultEffort !== "") {
      route.reasoningEffort = defaultEffort;
    }
  } catch {
    /* 无 effort 兜底 */
  }
  return route;
}

function headerOf(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === "request/header") return events[i].data?.header;
  }
  return undefined;
}

/** 工作目录解析(按权威度降级):
 *  ① 活会话 header.cwd(权威持久值)
 *  ② 工作区注册表实体 path(dsh-workspace 实体字段为 path,非 cwd/rootPath;
 *     注意其 sessionIds getter 会被 canonical-cwd 索引过滤,匹配不上就漏)
 *  ③ 客户端传来的 cwd(UI 显示的 sessions list byId cwd,兜底)
 *  返回 { cwd, source } 供诊断。 */
function cwdOf(ctx, sessionId, events, clientCwd) {
  const liveCwd = ctx.sessions.get(sessionId)?.header?.cwd;
  if (typeof liveCwd === "string" && liveCwd !== "") return { cwd: liveCwd, source: "live-header" };
  const headerCwd = headerOf(events)?.cwd;
  if (typeof headerCwd === "string" && headerCwd !== "") return { cwd: headerCwd, source: "request-header" };
  const workspace = (ctx.workspaceRegistry?.list?.() ?? [])
    .find((w) => Array.isArray(w?.sessionIds) && w.sessionIds.includes(sessionId));
  const wsCwd = workspace?.path ?? workspace?.cwd ?? workspace?.rootPath ?? workspace?.directory;
  if (typeof wsCwd === "string" && wsCwd !== "") return { cwd: wsCwd, source: "workspace-registry" };
  if (typeof clientCwd === "string" && clientCwd !== "") return { cwd: clientCwd, source: "client-cwd" };
  return { cwd: undefined, source: "none" };
}

/* ═══════════════ 增强上下文组装 ═══════════════ */

/** 从尾部向前折叠有界对话窗口(仅 user/assistant 文本块),按字符预算截断。 */
function boundedContext(events) {
  const parts = [];
  let used = 0;
  for (let i = events.length - 1; i >= 0 && used < CONTEXT_CHAR_BUDGET; i -= 1) {
    const event = events[i];
    if (event === null || typeof event !== "object") continue;
    let text = "";
    if (event.type === "user/message") text = textOfBlocks(event.data?.content);
    else if (event.type === "assistant/message") text = textOfBlocks(event.data?.message?.content);
    text = text.trim();
    if (text === "") continue;
    if (text.length > CONTEXT_LINE_CAP) text = text.slice(0, CONTEXT_LINE_CAP) + "…(已折叠)";
    const line = "[" + (event.type === "user/message" ? "用户" : "助手") + "] " + text;
    const room = CONTEXT_CHAR_BUDGET - used;
    const kept = line.length <= room ? line : line.slice(0, room);
    parts.unshift(kept);
    used += kept.length;
  }
  return parts.join("\n");
}

function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function buildPayload(draft, context, cwd, intensity, skills = [], outputEnglish = false) {
  const parts = [];
  if (typeof cwd === "string" && cwd !== "") {
    parts.push("【工作目录】\n" + cwd + "\n(参考文件路径一律使用相对该目录的路径;检索只用 glob/grep/read,不要遍历全仓。)");
  } else {
    parts.push("【工作目录】\n不可用——当前会话没有绑定工作目录。跳过仓库检索,不要编造任何文件路径,只做纯改写。");
  }
  if (context.trim() !== "") {
    parts.push("【对话上下文(最近窗口,用于保持话题与约束连续性)】\n" + context);
  }
  parts.push("【原始提示词(强化对象)】\n" + draft);
  if (skills.length > 0) {
    parts.push("【Skill 引用(必须原样保留)】\n上面的原始提示词包含以下宿主技能引用记号:/"
      + skills.join("、/")
      + "\n它们不是普通文字:宿主会扫描消息中的这些记号并注入对应技能的完整说明。强化结果必须逐字符保留每个记号(连斜杠),可融入正文或集中在「## 技能引用」节;禁止翻译、改写成描述性词语、加代码围栏或省略任何一个。");
  }
  let tail = "按你的系统指令强化上面的原始提示词;只输出强化后的提示词。";
  if (intensity === "low") {
    tail += "\n\n【本次强度:低】只做必要的措辞与结构润色,保持最接近原文的篇幅;禁止扩写、禁止引用任何文件路径、禁止输出「## 参考文件」清单。";
  } else if (intensity === "medium") {
    tail += "\n\n【本次强度:中】压缩输出:主体保持紧凑,通常不超过原文的 1.5 倍,不要为凑结构注水;「## 参考文件」节每行只列相对路径(不带「— 说明」后缀),最多 5 个文件;禁止附任何文件摘录或代码片段。";
  } else if (intensity === "high") {
    tail += "\n\n【本次强度:高】在不改变用户意图的前提下,允许适度展开背景、步骤与验收细节(通常不超过原文的 3 倍);参考文件节照常输出。";
  }
  if (outputEnglish === true) {
    tail += "\n\n【本次输出语言:英文】无论上面的原始提示词是什么语言,强化结果必须全部用英文书写(参考文件节标题固定为「## Reference Files」,集中技能引用节标题为「## Skill References」);skill 引用记号(/xxx)、文件路径与专有名词保持原样,不得翻译。";
  }
  parts.push(tail);
  return parts.join("\n\n");
}

/** 中档强度兜底:「## 参考文件」节内每行只保留路径(剥离「— 说明」),删除说明行、摘录与代码块;
 *  整节无有效清单行时删除整节(含标题)。只作用于中档(宿主强制,保证即使模型不听话输出也保持紧凑);低/高档不受影响。
 *  标题兼容「## 参考文件」与英文模式「## Reference Files」(两者都必须进入本兜底器,否则英文标题下会漏压缩/漏校验)。 */
function compactMediumReferences(text) {
  const lines = String(text).split("\n");
  const out = [];
  let inRefs = false;
  let inFence = false;
  let refsHeadingIndex = -1;
  let sectionEndIndex = -1; // 节内容在 out 中的结束位置(遇到下一标题或输入结束时落定)
  let keptListLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inRefs && trimmed.startsWith("```")) {
      inFence = !inFence;
      continue; // 节内代码块(摘录)连同围栏删除
    }
    if (!inRefs && /^##\s*(参考文件|reference\s+files\b)/i.test(trimmed)) {
      inRefs = true;
      refsHeadingIndex = out.length;
      out.push(line);
      continue;
    }
    if (inRefs && !inFence && /^#{1,6}\s/.test(trimmed)) {
      inRefs = false; // 参考节结束(下一个标题)
      sectionEndIndex = out.length;
      out.push(line);
      continue;
    }
    if (inRefs) {
      if (inFence) continue; // 代码块内容(摘录)删除
      const match = /^\s*[-*]\s+`?([^`\s][^`]*?)`?(?:\s+[—–-].*)?$/.exec(line);
      if (match !== null) {
        const candidate = match[1].trim();
        if (candidate !== "") {
          keptListLines += 1;
          out.push("- " + candidate); // 只保留路径
        }
        continue;
      }
      continue; // 说明行/摘录行/空行删除
    }
    out.push(line);
  }
  if (inRefs) sectionEndIndex = out.length; // 节延续到输入末尾
  if (sectionEndIndex > 0 && keptListLines === 0) {
    out.splice(refsHeadingIndex, sectionEndIndex - refsHeadingIndex);
    while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  }
  return out.join("\n");
}

/** 低档强度兜底:强制删除参考文件整节(含摘录;标题兼容中文与英文「## Reference Files」),保证输出不带任何文件引用。 */
function stripReferences(text) {
  const lines = String(text).split("\n");
  const out = [];
  let inRefs = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s*(参考文件|reference\s+files\b)/i.test(trimmed)) {
      inRefs = true;
      continue;
    }
    if (inRefs && /^#{1,6}\s/.test(trimmed)) inRefs = false; // 参考节结束(下一个标题)
    if (!inRefs) out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

/* ═══════════════ Skill 引用保留 ═══════════════ */

/** 从文本提取 skill 引用名。文法与宿主 dsh-tool-skill 的 SKILL_GESTURE 一致:
 *  行首或空白后的 /name(kebab-case),后随空白或行尾——宿主据此把技能全文
 *  注入对话。返回按首次出现顺序去重的名字列表。 */
function extractSkillNames(text) {
  const names = [];
  for (const match of String(text).matchAll(SKILL_GESTURE)) {
    const name = match[2];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/** 强化输出的 skill 引用兜底:检查增强稿是否仍含全部原始引用记号;
 *  缺失的记号以技能引用节追加到末尾(标题:中文模式「## 技能引用」、英文模式
 *  「## Skill References」;宿主对用户消息做全文 gesture 扫描,该节同样命中)。
 *  全部保留时不添加任何内容。 */
function ensureSkillReferences(text, names, outputEnglish = false) {
  const kept = extractSkillNames(text);
  const missing = names.filter((name) => !kept.includes(name));
  if (missing.length === 0) return { text, added: 0, requested: names.length, mode: "none" };
  const heading = outputEnglish ? "## Skill References" : "## 技能引用";
  const intro = outputEnglish
    ? "The following tokens are host-platform skill invocation markers; the host injects the full skill instructions after sending. Do not delete, rewrite or translate them:\n"
    : "以下记号是宿主平台的技能(skills)调用标记,发送后会由宿主注入对应技能的完整说明,不得删除、改写或翻译:\n";
  const section = "\n\n" + heading + "\n" + intro
    + missing.map((name) => "- /" + name).join("\n")
    + "\n";
  return {
    text: String(text).replace(/\s*$/, "") + section,
    added: missing.length,
    requested: names.length,
    mode: missing.length === names.length ? "all" : "partial",
  };
}

/* ═══════════════ 参考清单校验(防臆造路径) ═══════════════ */
/** 校验参考文件节(标题兼容「## 参考文件」与英文模式「## Reference Files」):相对 cwd 解析后不存在的路径行剔除;节内路径全无效则整节删除。
 *  只校验列表行(以 - / * 开头且能提取出路径的),说明行/摘录块原样保留。 */
function sanitizeReferences(text, cwd) {
  if (typeof cwd !== "string" || cwd === "") return { text, removed: 0 };
  const lines = text.split("\n");
  const out = [];
  let inRefs = false;
  let refsHeadingIndex = -1;
  let removed = 0;
  let kept = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (/^##\s*(参考文件|reference\s+files\b)/i.test(trimmed)) {
      inRefs = true;
      refsHeadingIndex = out.length;
      out.push(line);
      continue;
    }
    if (inRefs && !inFence && /^#{1,6}\s/.test(trimmed)) {
      inRefs = false; // 参考节结束
      out.push(line);
      continue;
    }
    if (inRefs && !inFence) {
      const match = /^\s*[-*]\s+`?([^`\s][^`]*?)`?(?:\s+[—–-].*)?$/.exec(line);
      if (match !== null) {
        const candidate = match[1].trim();
        if (candidate === "") {
          out.push(line);
          continue;
        }
        const abs = resolve(cwd, candidate);
        if (existsSync(abs)) {
          kept += 1;
          out.push(line);
        } else {
          removed += 1;
          // 剔除臆造路径行
        }
        continue;
      }
      out.push(line); // 非路径行(说明/摘录)原样保留
      continue;
    }
    out.push(line);
  }
  if (inRefs && refsHeadingIndex >= 0 && kept === 0 && removed > 0) {
    // 整节路径全部无效:删除节及尾部空行,避免"空参考清单"
    out.splice(refsHeadingIndex, out.length - refsHeadingIndex);
    removed += 1;
    while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  }
  return { text: out.join("\n"), removed };
}

/* ═══════════════ 子代理身份追加(descriptor) ═══════════════
 *
 * 契约:任何 header.origin="subagent" 的会话,其自身事件后缀里必须恰有一条
 * subagent/descriptor;否则 dsh-subagent 的身份投影(projection key "subagent")
 * 折叠为 null → 冷读路径(list-children 的 resolveColdIdentity)拿不到 identity →
 * 返回 {kind:"diagnostic", reason:"corrupt"} → UI 显示「会话记录损坏」。
 * 两条前置条件,缺一即 corrupt:① payload 的 version 等于宿主当前
 * SUBAGENT_DESCRIPTOR_VERSION(见上文三级解析);② 事件真的进了日志。
 *
 * 追加的落点必须是 **Agent 实例**,不是 ctx:setup 的第二参是 agent(官方驱动
 * dsh-subagent-in-process-driver 即用 `appendDelegatedPolicyOverrides(child.session)`),
 * 事件面 agent/pre-step 的载荷里也带 agent。**不存在 childCtx.agent** —— ctx 上注册的
 * 服务名是 `agents`(AgentRegistry 注册表),所以 `childCtx.agent.session` 抛
 * TypeError;旧实现把它包在 try/catch 里只 warn,于是每次强化都静默少写一条
 * descriptor,子会话必然被判 corrupt(2026-09-12 实证:真实子会话日志里只有
 * session/end-seed、permission/preset…,foldSubagentDescriptor([]) === undefined)。
 *
 * 双通道,appended 标志保证恰好一条:
 *   ① setup 窗口立即追加(第二参可用时)——连未被 step 就取消的子会话也带身份;
 *   ② 退化到与官方驱动同形的首步 agent/pre-step 追加(宿主若不再传第二参)。
 * 两个落点都不可用时落盘醒目的诊断(armed=false):这等价于该子会话注定 corrupt,
 * 必须能在 prompt-enhancer-diag.log 里查到,而不是只在宿主 logger 里一闪而过。 */
function installDescriptorAppend(childCtx, child, payload) {
  let appended = false;
  let armed = false;
  let path = null;
  const append = (agent) => {
    if (appended) return false;
    const session = agent?.session;
    if (session === undefined || typeof session.append !== "function") return false;
    session.append("subagent/descriptor", payload);
    appended = true;
    return true;
  };
  if (append(child)) {
    armed = true;
    path = "setup-arg";
  } else {
    try {
      childCtx.on("agent/pre-step", async ({ agent }, next) => {
        const decision = await next();
        if (!appended && decision?.kind === "enter" && append(agent)) path = "pre-step";
        return decision;
      });
      armed = true;
    } catch { /* 事件面不可用:只剩 setup 窗口那一次机会 */ }
  }
  return { appended: () => appended, armed: () => armed, path: () => path };
}

/** 子代理身份(descriptor)安装器:见上文「子代理身份追加」契约说明。 */

/** 读一次会话事件(跨宿主代际兼容入口)。
 *  dsh-session 的 Session 事件面在代际之间改过名:0.1.2-alpha.1 及更早只有
 *  getter `events`(无 snapshotEvents),0.1.2-rc.1 两者都有,0.1.5-rc.2 的类表面
 *  只剩 `snapshotEvents()`。插件横跨这些代际,所以两个入口都试(先文档化的
 *  snapshotEvents(),再旧 getter),都没有才返回空数组——绝不让一次宿主改版把
 *  「读事件」变成 TypeError 而中断整条强化(与 descriptor 落点同类的事故形态)。 */
function sessionEvents(session) {
  if (session === undefined || session === null) return [];
  if (typeof session.snapshotEvents === "function") {
    const events = session.snapshotEvents();
    if (Array.isArray(events)) return events;
  }
  return Array.isArray(session.events) ? session.events : [];
}

/* ═══════════════ 通道 B:隔离子会话 agent ═══════════════ */

/** 跑一次强化子会话。joinPreset=true:继承父会话预设组合(composeFrom + persona +
 * 只读限制);false:裸子会话(只注入 persona,不 join 任何预设——预设层的首轮机制
 * 不会作用于它,退化为纯改写)。fatal 错误(超时/客户端取消)以 error.fatal 标记,
 * 调用方不应重试;无文本/回合错误可重试。 */
async function runEnhanceChild(ctx, parent, route, cwd, payload, sessionId, signal, modelCfg, joinPreset, persona) {
  // 配置了专用模型:agentOptions 覆盖 provider/model;effort 经 agent/request waterfall 注入
  // (agent-loop 的 buildRequest 只从会话 header 继承 effort,子会话 header 无此配置)。
  const effectiveProvider = modelCfg?.provider ?? route.provider;
  const effectiveModel = modelCfg?.model ?? route.model;
  const childId = "session-" + globalThis.crypto.randomUUID();
  let descriptorInstall;
  const setup = (childCtx, child) => {
    // 子代理身份(version + 落点两条契约见 installDescriptorAppend 说明)。
    descriptorInstall = installDescriptorAppend(childCtx, child, {
      version: descriptorVersion,
      mode: "one-shot",
      provider: "prompt-enhancer",
      label: "提示词强化",
    });
    // 继承父会话工具组合(与 dsh-subagent applyChildComposition 同法);
    // 裸子会话不 join 父组合——预设层的首轮监听(router bootstrap 等)不会作用于它
    if (joinPreset) {
      try {
        const presets = childCtx.get?.("agentPresets");
        if (presets !== undefined && typeof presets.composeFrom === "function") {
          presets.composeFrom(childCtx, parent.ctx);
        }
      } catch (error) {
        ctx.logger?.warn("[dsh-prompt-enhancer] composeFrom 失败(子会话无工具): " + String(error));
      }
    }
    // 强化专用 persona 遮蔽父 persona(同名同序段);persona 由调用方按
    // 「转换英文」开关生成(英文输出时语言规则与节标题随之切换)
    try {
      childCtx.systemPrompt?.section?.({ name: "deployment:persona", order: 0, text: persona });
    } catch (error) {
      ctx.logger?.warn("[dsh-prompt-enhancer] systemPrompt.section 失败: " + String(error));
    }
    // 只读工具限制(预设目录缺只读工具名时 restrict 抛未知名→整体放弃限制——
    // 退化为无限制,不阻断创建;裸子会话的全局目录同样可能缺 read,同法)
    if (joinPreset) {
      try {
        childCtx.tools?.restrict?.({ allow: READONLY_TOOLS });
      } catch (error) {
        ctx.logger?.warn("[dsh-prompt-enhancer] tools.restrict 失败(退化:无工具限制): " + String(error));
      }
    }
    // 专用模型 + 思考强度:waterfall 覆盖请求配置(与 installModelSelection 同法)
    if (modelCfg !== undefined) {
      try {
        childCtx.on?.("agent/request", async (_payload, next) => {
          const resolved = await next();
          return {
            ...resolved,
            provider: modelCfg.provider,
            model: modelCfg.model,
            ...(typeof modelCfg.reasoningEffort === "string" && modelCfg.reasoningEffort !== ""
              ? { reasoningEffort: modelCfg.reasoningEffort }
              : {}),
          };
        });
      } catch (error) {
        ctx.logger?.warn("[dsh-prompt-enhancer] agent/request waterfall 注入失败(退化:子会话用继承模型): " + String(error));
      }
    }
  };
  // 与官方 childSessionMeta 同构:origin/父会话/委派深度(父深度+1,父不可用按顶层 0 计)。
  const parentDepth = parent?.session?.header?.delegationDepth ?? 0;
  const meta = { parentSession: sessionId, origin: "subagent", delegationDepth: parentDepth + 1 };
  if (cwd !== undefined) meta.cwd = cwd;
  const handle = await ctx.agents.create({
    sessionId: childId,
    seed: [],
    meta,
    agentOptions: {
      provider: effectiveProvider,
      model: effectiveModel,
      ...(route.reasoningEffort !== undefined && modelCfg === undefined ? { reasoningEffort: route.reasoningEffort } : {}),
      ...(route.maxTokens !== undefined ? { maxTokens: route.maxTokens } : {}),
    },
    setup,
  });
  const inverses = [];
  const descriptorState = () => ({
    descriptorAppended: descriptorInstall?.appended() === true,
    descriptorArmed: descriptorInstall?.armed() === true,
    descriptorPath: descriptorInstall?.path() ?? null,
  });
  try {
    diagLog("enhance-child-ready", {
      sessionId,
      childId,
      childCwd: handle.agent?.session?.header?.cwd ?? null,
      metaCwd: cwd ?? null,
      joinPreset,
      ...descriptorState(),
    });
    if (descriptorInstall?.armed() !== true) {
      // 两个落点都不可用 ⇒ 该子会话必然被判 corrupt;必须留痕(旧实现只 warn 且被吞)
      ctx.logger?.warn("[dsh-prompt-enhancer] 子代理身份未追加成功,该子会话会显示为「会话记录损坏」: " + childId);
      diagLog("enhance-child-descriptor-unarmed", { sessionId, childId, joinPreset, ...descriptorState() });
    }
    // 绑定父工作区,保证 glob/grep/read 落在仓库根上
    const workspace = (ctx.workspaceRegistry?.list?.() ?? [])
      .find((w) => Array.isArray(w?.sessionIds) && w.sessionIds.includes(sessionId));
    if (workspace !== undefined && typeof workspace.attachSession === "function") {
      await workspace.attachSession(childId);
      inverses.push(() => workspace.detachSession?.(childId));
    }
    handle.agent.followup(userMessage(payload));
    await waitForTurn(handle.agent, CHILD_TIMEOUT_MS, signal, "强化子会话");
    const text = lastAssistantText(sessionEvents(handle.agent.session));
    if (text === "") {
      // 子会话回合结束却无文本:回合内部错误此前被吞掉(只读助手文本)。
      // 把全部事件落盘诊断,并尽量从错误事件里提炼一句可读原因。
      const events = sessionEvents(handle.agent.session);
      const digest = events.map((event) => ({ type: event?.type, data: truncateJson(event?.data, 600) }));
      const errorEvent = [...events].reverse().find((event) => String(event?.type ?? "").includes("error"));
      const rawCause = errorEvent === undefined ? undefined : (errorEvent.data?.error?.message ?? errorEvent.data?.message ?? errorEvent.data?.error);
      const cause = rawCause === undefined || rawCause === null ? "" : String(rawCause);
      diagLog("enhance-child-no-text", {
        sessionId,
        childId,
        joinPreset,
        childStatus: handle.agent?.status,
        eventCount: events.length,
        events: digest,
      });
      const error = new Error("强化子会话没有产出文本" + (cause !== "" ? "——" + cause : ""));
      error.noText = true;
      throw error;
    }
    return { text, truncated: childOutputTruncated(sessionEvents(handle.agent.session)) };
  } finally {
    // 身份审计:以会话自身事件为准(不信安装器的自称),descriptor 缺失即注定 corrupt
    try {
      const events = sessionEvents(handle.agent?.session);
      const descriptorEvents = events.filter((event) => event?.type === "subagent/descriptor").length;
      diagLog("enhance-child-descriptor-final", {
        sessionId,
        childId,
        joinPreset,
        descriptorEvents,
        ...descriptorState(),
      });
      if (descriptorEvents === 0) {
        ctx.logger?.warn("[dsh-prompt-enhancer] 强化子会话缺少 subagent/descriptor,会被判「会话记录损坏」: " + childId);
      }
    } catch { /* 审计失败不影响主流程 */ }
    for (const inverse of inverses.reverse()) {
      try {
        await inverse();
      } catch { /* 工作区解绑失败静默 */ }
    }
    await handle.dispose();
  }
}

/** 通道 B:隔离子会话 agent。先以继承父会话预设组合的方式尝试;当父预设携带与
 * 全新子会话首轮不兼容的机制(如 router 预设 bootstrap 要求平台 shell 在目录中,
 * 而只读限制已将其移除——子会话首轮直接 turn 错误、无文本)时,退化为不 join
 * 预设的裸子会话重试一次(纯改写、无文件检索——ADR-0001「无工具时 B 退化为纯
 * 改写」语义)。致命错误(超时/客户端取消, error.fatal)不重试。 */
async function enhanceWithChildAgent(ctx, route, cwd, payload, sessionId, signal, modelCfg, persona) {
  const parent = ctx.agents.get(sessionId);
  if (parent !== undefined) {
    try {
      return await runEnhanceChild(ctx, parent, route, cwd, payload, sessionId, signal, modelCfg, true, persona);
    } catch (error) {
      if (error?.fatal === true || signal?.aborted === true) throw error;
      // 预设组合无文本(如 router-bootstrap: no platform shell in catalog)或
      // 子会话创建失败:裸子会话(纯改写)重试
      ctx.logger?.warn("[dsh-prompt-enhancer] 通道 B 预设组合无产出,裸子会话重试: " + String(error?.message ?? error));
      diagLog("enhance-child-retry-bare", { sessionId, reason: String(error?.message ?? error) });
    }
  }
  return await runEnhanceChild(ctx, parent, route, cwd, payload, sessionId, signal, modelCfg, parent === undefined, persona);
}

/** 等待子代理回合结束:超时(90s)与客户端取消(signal)都会 cancel 子代理。 */
async function waitForTurn(agent, timeoutMs, signal, label) {
  const cancel = (reason) => {
    try {
      agent.cancel(new Error(label + "中止: " + reason));
    } catch { /* cancel 失败随 dispose 收敛 */ }
  };
  let timer;
  const onAbort = () => cancel("客户端取消");
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      agent.activityDone,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          cancel("超时(" + timeoutMs + "ms)");
          const error = new Error(label + "超时(" + timeoutMs + "ms)");
          error.fatal = true; // 超时不重试:裸子会话会再次挂满整个预算
          reject(error);
        }, timeoutMs);
      }),
      signal === undefined
        ? new Promise(() => {})
        : new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              const error = new Error(label + "被取消");
              error.fatal = true; // 客户端已离开,不重试
              if (signal.reason !== undefined) error.cause = signal.reason;
              reject(error);
            }, { once: true });
          }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** 取子代理最终文本回复:从尾部向前找有文本的助手消息;清洗伪工具调用文本
 *  (不支持原生 function-calling 的适配器会把工具调用语法写进文本,必须剔除)。 */
function lastAssistantText(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== "assistant/message") continue;
    const text = cleanAssistantText(textOfBlocks(event.data?.message?.content)).trim();
    if (text !== "") return text;
  }
  return "";
}
/** 子会话最终文本的来源步是否被 maxTokens 截断(纯函数:单测)。
 *  会话事件流按步记录:先 assistant/chunk 的 finish 块(data.chunk 为 LLM 原始
 *  chunk,含 reason.kind),随后该步对应的 assistant/message(实测 seq 相邻)。
 *  取与 lastAssistantText 同源的事件(最后一个有非空文本的 assistant/message),
 *  向前找其紧邻的 finish 块:reason.kind === "max-tokens" 即该步输出被输出上限截断。 */
function childOutputTruncated(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== "assistant/message") continue;
    if (cleanAssistantText(textOfBlocks(event.data?.message?.content)).trim() === "") continue;
    for (let j = i - 1; j >= 0; j -= 1) {
      const chunkEvent = events[j];
      if (chunkEvent?.type === "assistant/chunk" && chunkEvent?.data?.chunk?.type === "finish") {
        return chunkEvent.data.chunk.reason?.kind === "max-tokens";
      }
    }
    return false;
  }
  return false;
}

/** 剔除模型文本中的伪工具调用块(各种常见方言)。 */
function cleanAssistantText(text) {
  return String(text)
    .replace(/<tool_call\b[\s\S]*?<\/tool_call>/g, "")
    .replace(/<function\b[\s\S]*?<\/function>/g, "")
    .replace(/<parameter\b[\s\S]*?<\/parameter>/g, "")
    .replace(/<tool_use\b[\s\S]*?<\/tool_use>/g, "")
    .replace(/<tool-call\b[\s\S]*?<\/tool-call>/g, "")
    .replace(/<invoke\b[\s\S]*?<\/invoke>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ═══════════════ 通道 A:llm 直调降级 ═══════════════ */

async function enhanceWithLlm(ctx, route, payload, signal, modelCfg, persona) {
  let text = "";
  let truncated = false;
  const provider = modelCfg?.provider ?? route.provider;
  const model = modelCfg?.model ?? route.model;
  const reasoningEffort =
    modelCfg?.reasoningEffort ??
    (modelCfg === undefined ? route.reasoningEffort : undefined);
  const stream = ctx.llm.stream({
    provider,
    model,
    system: persona,
    messages: [userMessage(payload)],
    temperature: 0.2,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(route.maxTokens !== undefined ? { maxTokens: route.maxTokens } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  const consume = (async () => {
    for await (const chunk of stream) {
      if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
      if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
        throw new Error(chunk.reason?.failure?.message ?? "LLM 调用失败");
      }
      if (chunk?.type === "finish" && chunk.reason?.kind === "max-tokens") truncated = true;
    }
  })();
  await withTimeout(consume, FALLBACK_TIMEOUT_MS, undefined);
  const trimmed = cleanAssistantText(text).trim();
  if (trimmed === "") throw new Error("LLM 无输出");
  return { text: trimmed, truncated };
}

/* ═══════════════ 工具函数 ═══════════════ */

function userMessage(text) {
  return {
    id: globalThis.crypto.randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

async function withTimeout(promise, ms, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } catch { /* 超时回调失败不掩盖超时语义 */ }
          reject(new Error("操作超时(" + ms + "ms)"));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
