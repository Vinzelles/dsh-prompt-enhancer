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
 *   通道 B 超时 90s / 通道 A 超时 60s / 保持输入语言 / 软长度约原文 2 倍。
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

import { appendFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIAG_FILE = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "super-injector", "prompt-enhancer-diag.log");

/* ═══════════════ 第三方依赖加载 ═══════════════
 * 本插件在 profile node_modules 里是 junction 指向源码目录,源码目录没有 node_modules;
 * cordis loader 的静态裸 specifier 解析会从 realpath 后的位置向上找,必然失败
 * (Node 内部报 "job must be an instance of ModuleJob")。因此这里不写静态 import,
 * 而是运行时 await import() 绝对 file URL:dsh-settings/schemastery 物理位于
 * 宿主依赖树内,其自身依赖从它们所在目录的 node_modules 树解析,天然成功。 */

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
  const here = dirname(fileURLToPath(import.meta.url));
  for (let dir = here; ; ) {
    add(join(dir, "node_modules"));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // ⑤ Windows desktop 官方依赖树(宿主自该树启动时 @deepseek-ai/* 的物理位置)
  if (process.platform === "win32") {
    add(join(homedir(), "AppData", "Roaming", "io.github.hairyf.deepseek-harness-desktop", "dependencies", "dsh", "node_modules"));
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

const SETTINGS_PKG_DIR = findPackageDir("@deepseek-ai/dsh-settings");
const SCHEMA_PKG_DIR = findPackageDir("@deepseek-ai/schemastery");

/** 运行时加载 @deepseek-ai/dsh-settings(installSettingsSection / settingsNamespace)。 */
async function loadDshSettings() {
  const entry = join(SETTINGS_PKG_DIR, "lib", "index.js");
  return await import(pathToFileURL(entry).href);
}

/** 运行时加载 @deepseek-ai/schemastery(Schema 对象)。 */
async function loadSchemastery() {
  const entry = join(SCHEMA_PKG_DIR, "lib", "index.mjs");
  return await import(pathToFileURL(entry).href);
}

/* ═══════════════ 用户设置(schema + 生效值源) ═══════════════ */

if (SETTINGS_PKG_DIR === undefined || SCHEMA_PKG_DIR === undefined) {
  const msg = `[dsh-prompt-enhancer] 未能定位 @deepseek-ai 依赖(dsh-settings=${SETTINGS_PKG_DIR ?? "未找到"}, schemastery=${SCHEMA_PKG_DIR ?? "未找到"}),设置卡片不可用——依赖应位于 profile node_modules(顶层或 .pnpm 虚拟存储)或 desktop 官方依赖树内`;
  try { diagLog("deps-resolution-failed", { dshSettings: SETTINGS_PKG_DIR ?? null, schemastery: SCHEMA_PKG_DIR ?? null }); } catch {}
  throw new Error(msg);
}
try { diagLog("deps-resolved", { dshSettings: SETTINGS_PKG_DIR, schemastery: SCHEMA_PKG_DIR }); } catch {}
const dshSettingsMod = await loadDshSettings();
const { installSettingsSection, settingsNamespace } = dshSettingsMod;
const Schema = (await loadSchemastery()).default;
const SETTINGS_NS = settingsNamespace("prompt-enhancer");

/** 设置 schema:model(可选专用模型)+ intensity(强化程度)。
 *  不配置 model = 跟随会话默认模型;intensity 控制输出长度,low 档不带文件引用。
 *  注意:schemastery 的对象字段用 .default(null) 表达可选(实测 .required(false)
 *  在对象字段上不生效,空文档会抛 "model.provider missing required value")。 */
const SETTINGS_SCHEMA = Schema.object({
  model: Schema.object({
    provider: Schema.string().required(),
    model: Schema.string().required(),
    reasoningEffort: Schema.string().required(false),
  }).default(null),
  intensity: Schema.union(["low", "medium", "high"]).default("medium"),
});

/** 生效配置源:settings 服务挂载后指向其 scope.get(),否则指向入口 base。 */
let configSource = () => ({ intensity: "medium" });

/** 读取当前生效配置(每次请求时调用,保证用户改设置即时生效)。 */
function enhanceConfig() {
  const value = configSource() ?? {};
  const intensity = value.intensity === "low" || value.intensity === "high" ? value.intensity : "medium";
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
  return { intensity, model };
}

function diagLog(stage, detail) {
  try {
    mkdirSync(dirname(DIAG_FILE), { recursive: true });
    appendFileSync(DIAG_FILE, "[" + new Date().toISOString() + "] " + stage + " " + JSON.stringify(detail ?? {}) + "\n");
  } catch { /* 诊断日志失败静默 */ }
}

/** 强化专用 persona:子会话系统段(遮蔽父 persona)与通道 A 的 system 共用。 */
const ENHANCER_PERSONA = [
  "你是「提示词增强器」(Prompt Enhancer)。唯一任务:把用户提交的一条原始提示词改写为结构清晰、约束明确、可直接交给 AI 编程 agent 执行的任务提示词,并在末尾附上参考文件清单。",
  "规则:",
  "1. 保持用户输入的语言(中文进中文出、英文进英文出),禁止翻译。",
  "2. 不改变用户真实意图:不得新增用户没要求的功能,不得删除或弱化用户已提出的需求;可对需求做澄清性展开(目标/背景/步骤/约束/验收),并追加最少必要的工作指令(如「先阅读参考文件再动手」)。",
  "3. 结构建议(按需选用,不要机械套用):目标 / 背景(如有) / 步骤 / 约束 / 验收标准。",
  "4. 长度软约束:通常不超过原文的 2 倍;不要为凑结构注水。",
  "5. 仓库知识:若当前工作目录存在,用 glob/grep/read 等只读工具基于原始提示词的关键词,有界地定位 ≤5 个最相关文件(优先 README、docs、架构说明、规则文件,其次直接相关的源码);不要遍历全仓。",
  "6. 参考文件清单:在输出末尾加「## 参考文件」一节,每行「- 相对路径 — 一句话相关性说明」。只列你实际用 glob/grep/read 打开并确认存在的文件,禁止臆测或猜测路径(宿主会自动校验并剔除不存在的路径);未找到相关文件或没有工作目录时省略该节。",
  "7. 摘录:最多对 2 个「高相关且短」的文件在清单后附 ≤20 行关键摘录;其余文件只给路径与说明。",
  "8. 输出格式:只输出改写后的提示词本身(含参考文件节);禁止输出任何解释、前言、确认语或代码围栏。",
  "9. Skill 引用:原始提示词中的 /skill-name 形式记号是宿主平台的技能(skill)调用语法,发送后由宿主识别并注入技能全文——它们不是普通文字。必须原样保留原始提示词中的每一个这类记号(连斜杠一起逐字符照抄,可融入正文或集中放在「## 技能引用」节);禁止翻译、禁止改写成描述性词语(如把 /tdd 写成「TDD 流程」)、禁止加代码围栏、禁止删除。",
].join("\n");

export const name = "@dsh-external/dsh-prompt-enhancer";
export const inject = ["sessions", "agents", "llm", "webServer", "workspaceRegistry", "sessionQuery"];

export function apply(ctx) {
  // 用户设置命名空间(设置 → 插件 → 插件配置 → 提示词强化卡片)
  try {
    installSettingsSection(ctx, SETTINGS_NS, SETTINGS_SCHEMA, { intensity: "medium" }, {
      setSource: (next) => {
        configSource = next;
        diagLog("settings-source-set", { ns: String(SETTINGS_NS) });
      },
      onChange: () => {
        diagLog("settings-change", { ns: String(SETTINGS_NS) });
      },
    });
    diagLog("settings-installed", { ns: String(SETTINGS_NS) });
  } catch (error) {
    diagLog("settings-install-error", { message: String(error?.message ?? error) });
    ctx.logger?.warn("[dsh-prompt-enhancer] settings 注册失败(设置卡片不可用): " + String(error));
  }
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
    // Skill 引用提取(与宿主同文法):供 payload 约束与输出兜底校验
    const referencedSkills = extractSkillNames(draft);
    if (referencedSkills.length > 0) diagLog("skill-refs-extracted", { sessionId, skills: referencedSkills });
    const source = await readSource(ctx, sessionId);
    const route = await routeOf(ctx, sessionId, source.events);
    const resolved = cwdOf(ctx, sessionId, source.events, clientCwd);
    const cwd = resolved.cwd;
    const cfg = enhanceConfig();
    diagLog("enhance-start", {
      sessionId,
      cwd: cwd ?? null,
      cwdSource: resolved.source,
      clientCwd: clientCwd ?? null,
      draftLength: draft.length,
      intensity: cfg.intensity,
      model: cfg.model ?? null,
    });
    const context = boundedContext(source.events);
    const payload = buildPayload(draft, context, cwd, cfg.intensity, referencedSkills);

    let enhanced;
    try {
      enhanced = await enhanceWithChildAgent(ctx, route, cwd, payload, sessionId, aborted.signal, cfg.model);
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
      enhanced = await enhanceWithLlm(ctx, route, payload, aborted.signal, cfg.model);
    }
    // 防臆造路径:参考清单逐行校验存在性
    const sanitized = sanitizeReferences(enhanced, cwd);
    if (sanitized.removed > 0) {
      diagLog("enhance-refs-sanitized", { sessionId, removed: sanitized.removed, cwd: cwd ?? null });
      enhanced = sanitized.text;
    }
    // Skill 引用兜底:输出丢失记号时确定性回填「## 技能引用」节
    if (referencedSkills.length > 0) {
      const restored = ensureSkillReferences(enhanced, referencedSkills);
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
    respondJson(response, 200, { enhanced });
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

function buildPayload(draft, context, cwd, intensity, skills = []) {
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
  parts.push(tail);
  return parts.join("\n\n");
}

/** 中档强度兜底:「## 参考文件」节内每行只保留路径(剥离「— 说明」),删除说明行、摘录与代码块;
 *  整节无有效清单行时删除整节(含标题)。只作用于中档(宿主强制,保证即使模型不听话输出也保持紧凑);低/高档不受影响。 */
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
    if (!inRefs && /^##\s*参考文件/i.test(trimmed)) {
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

/** 低档强度兜底:强制删除「## 参考文件」整节(含摘录),保证输出不带任何文件引用。 */
function stripReferences(text) {
  const lines = String(text).split("\n");
  const out = [];
  let inRefs = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s*参考文件/i.test(trimmed)) {
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
 *  缺失的记号以「## 技能引用」节追加到末尾(宿主对用户消息做全文 gesture
 *  扫描,该节同样命中)。全部保留时不添加任何内容。 */
function ensureSkillReferences(text, names) {
  const kept = extractSkillNames(text);
  const missing = names.filter((name) => !kept.includes(name));
  if (missing.length === 0) return { text, added: 0, requested: names.length, mode: "none" };
  const section = "\n\n## 技能引用\n以下记号是宿主平台的技能(skills)调用标记,发送后会由宿主注入对应技能的完整说明,不得删除、改写或翻译:\n"
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
/** 校验「## 参考文件」节:相对 cwd 解析后不存在的路径行剔除;节内路径全无效则整节删除。
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
    if (/^##\s*参考文件/i.test(trimmed)) {
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

/* ═══════════════ 通道 B:隔离子会话 agent ═══════════════ */

/** 跑一次强化子会话。joinPreset=true:继承父会话预设组合(composeFrom + persona +
 * 只读限制);false:裸子会话(只注入 persona,不 join 任何预设——预设层的首轮机制
 * 不会作用于它,退化为纯改写)。fatal 错误(超时/客户端取消)以 error.fatal 标记,
 * 调用方不应重试;无文本/回合错误可重试。 */
async function runEnhanceChild(ctx, parent, route, cwd, payload, sessionId, signal, modelCfg, joinPreset) {
  // 配置了专用模型:agentOptions 覆盖 provider/model;effort 经 agent/request waterfall 注入
  // (agent-loop 的 buildRequest 只从会话 header 继承 effort,子会话 header 无此配置)。
  const effectiveProvider = modelCfg?.provider ?? route.provider;
  const effectiveModel = modelCfg?.model ?? route.model;
  const childId = "session-" + globalThis.crypto.randomUUID();
  const setup = (childCtx) => {
    // 子代理目录身份契约:任何 origin="subagent" 的会话都必须有一条
    // subagent/descriptor 事件,否则 dsh-subagent 的 catalog 无法折叠出子代理身份,
    // 会把该会话判为 corrupt(界面显示「会话记录损坏」)。官方驱动
    // (dsh-subagent-in-process-driver)在首步 pre-step 追加;本插件在创建窗口内
    // 直接补写 one-shot descriptor,保证即使子会话被取消/无文本也带上身份。
    try {
      childCtx.agent.session.append("subagent/descriptor", {
        version: 2,
        mode: "one-shot",
        provider: "prompt-enhancer",
        label: "提示词强化",
      });
    } catch (error) {
      ctx.logger?.warn("[dsh-prompt-enhancer] subagent/descriptor 追加失败: " + String(error));
    }
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
    // 强化专用 persona 遮蔽父 persona(同名同序段)
    try {
      childCtx.systemPrompt?.section?.({ name: "deployment:persona", order: 0, text: ENHANCER_PERSONA });
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
  try {
    diagLog("enhance-child-ready", {
      sessionId,
      childId,
      childCwd: handle.agent?.session?.header?.cwd ?? null,
      metaCwd: cwd ?? null,
      joinPreset,
    });
    // 绑定父工作区,保证 glob/grep/read 落在仓库根上
    const workspace = (ctx.workspaceRegistry?.list?.() ?? [])
      .find((w) => Array.isArray(w?.sessionIds) && w.sessionIds.includes(sessionId));
    if (workspace !== undefined && typeof workspace.attachSession === "function") {
      await workspace.attachSession(childId);
      inverses.push(() => workspace.detachSession?.(childId));
    }
    handle.agent.followup(userMessage(payload));
    await waitForTurn(handle.agent, CHILD_TIMEOUT_MS, signal, "强化子会话");
    const text = lastAssistantText(handle.agent.session.events);
    if (text === "") {
      // 子会话回合结束却无文本:回合内部错误此前被吞掉(只读助手文本)。
      // 把全部事件落盘诊断,并尽量从错误事件里提炼一句可读原因。
      const events = handle.agent.session.events;
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
    return text;
  } finally {
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
async function enhanceWithChildAgent(ctx, route, cwd, payload, sessionId, signal, modelCfg) {
  const parent = ctx.agents.get(sessionId);
  if (parent !== undefined) {
    try {
      return await runEnhanceChild(ctx, parent, route, cwd, payload, sessionId, signal, modelCfg, true);
    } catch (error) {
      if (error?.fatal === true || signal?.aborted === true) throw error;
      // 预设组合无文本(如 router-bootstrap: no platform shell in catalog)或
      // 子会话创建失败:裸子会话(纯改写)重试
      ctx.logger?.warn("[dsh-prompt-enhancer] 通道 B 预设组合无产出,裸子会话重试: " + String(error?.message ?? error));
      diagLog("enhance-child-retry-bare", { sessionId, reason: String(error?.message ?? error) });
    }
  }
  return await runEnhanceChild(ctx, parent, route, cwd, payload, sessionId, signal, modelCfg, parent === undefined);
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

async function enhanceWithLlm(ctx, route, payload, signal, modelCfg) {
  let text = "";
  const provider = modelCfg?.provider ?? route.provider;
  const model = modelCfg?.model ?? route.model;
  const reasoningEffort =
    modelCfg?.reasoningEffort ??
    (modelCfg === undefined ? route.reasoningEffort : undefined);
  const stream = ctx.llm.stream({
    provider,
    model,
    system: ENHANCER_PERSONA,
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
    }
  })();
  await withTimeout(consume, FALLBACK_TIMEOUT_MS, undefined);
  const trimmed = cleanAssistantText(text).trim();
  if (trimmed === "") throw new Error("LLM 无输出");
  return trimmed;
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
