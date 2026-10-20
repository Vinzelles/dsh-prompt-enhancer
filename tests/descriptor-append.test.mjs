// 子代理身份「落点」契约回归测试(2026-09-12 事故:descriptor 从未落盘 → 会话记录损坏)。
//
// 事故根因(与本仓库 0.1.3 之前的实现一致):插件在 setup 里写
//   childCtx.agent.session.append("subagent/descriptor", …)
// 但宿主 ctx 上注册的服务名是 `agents`(AgentRegistry 注册表),**不存在 `agent` 属性**
// ——官方驱动 @deepseek-ai/dsh-subagent-in-process-driver 用的是 setup 第二参
// (`appendDelegatedPolicyOverrides(child.session, …)`)或 agent/pre-step 载荷里的 agent。
// 于是这行每次都在 setup 窗口抛 TypeError,又被 try/catch 吞成一条 logger.warn:
// 子会话日志里一条 descriptor 都没有 → dsh-subagent 的 "subagent" 身份投影折叠为 null →
// 冷读路径 list-children.resolveColdIdentity 判 {kind:"diagnostic",reason:"corrupt"} →
// UI 显示「会话记录损坏」。
//
// 五段:① 落点行为(setup 第二参优先 / pre-step 兜底 / 恰好一条 / 未武装可观测);
// ② 静态防回归(旧形态 `childCtx.agent.` 不得复活)+ 事件读取入口跨代兼容;
// ③ 载荷契约(宿主真实 fold);④ 端到端折叠(真实身份投影:有 descriptor → 身份,
// 无 descriptor → null=corrupt);⑤ 真实宿主 Session 的写路径 + 信封 + seq 一起验。
// 注意本文件只锚「身份事件有没有落到日志里、落得对不对」,版本号的跨代解析由
// descriptor-version.test.mjs 负责(两者合起来才是完整的「不损坏」契约)。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
/** 静态断言只看代码:注释里会引用事故形态本身(如 root-cause 说明),不该被判为残留。 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "");

function slice(startMarker, endMarker = "\n}\n") {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error("marker not found: " + startMarker);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error("end marker not found: " + endMarker);
  return src.slice(start, end + endMarker.length);
}

/* ── 被测函数:从源码切片装配(与宿主无关的纯函数) ── */
const installDescriptorAppend = new Function(
  slice("function installDescriptorAppend") + "\nreturn installDescriptorAppend;",
)();

// 负载形状固定;version 由插件加载时按宿主契约解析(见 descriptor-version.test.mjs)。
// 凡进入宿主 fold 的用例都用宿主常量覆盖这个占位值。
const PAYLOAD = { version: 3, mode: "one-shot", provider: "prompt-enhancer", label: "提示词强化" };

/** 假 Agent:session.append 逐条记账。 */
function fakeAgent() {
  const appended = [];
  return {
    appended,
    agent: { session: { append: (type, data) => appended.push({ type, data }) } },
  };
}

/** 假 childCtx:记录事件面注册(真实 ctx 没有 .agent,这里刻意也不放)。 */
function fakeCtx({ withOn = true } = {}) {
  const listeners = new Map();
  const ctx = {
    listeners,
    on(name, handler) {
      if (!withOn) throw new Error("event surface unavailable");
      listeners.set(name, handler);
      return () => listeners.delete(name);
    },
  };
  return ctx;
}

/** 触发一次 pre-step(pre-step 是 waterfall:先 await next() 拿 decision,再决定是否追加)。 */
async function firePreStep(ctx, agent, decision) {
  const handler = ctx.listeners.get("agent/pre-step");
  assert.ok(handler !== undefined, "pre-step listener must be registered");
  return await handler({ agent }, async () => decision);
}

/* ── ① 落点行为 ── */
test("setup second argument (the Agent) is the primary append path", () => {
  const ctx = fakeCtx();
  const { agent, appended } = fakeAgent();
  const install = installDescriptorAppend(ctx, agent, PAYLOAD);
  assert.equal(install.appended(), true);
  assert.equal(install.armed(), true);
  assert.equal(install.path(), "setup-arg");
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0], { type: "subagent/descriptor", data: PAYLOAD });
  // 主通道已成功 ⇒ 不再挂 pre-step 监听(少一层事件面耦合)
  assert.equal(ctx.listeners.size, 0);
});

test("a ctx-only first argument (no Agent) never appends by itself", () => {
  // 旧实现的形态:第二参缺失时第一参就是 ctx;ctx 上没有 .agent/.session
  const ctx = fakeCtx();
  const install = installDescriptorAppend(ctx, ctx, PAYLOAD);
  assert.equal(install.appended(), false);
  assert.equal(install.armed(), true, "pre-step fallback must be armed");
  assert.equal(install.path(), null);
});

test("pre-step fallback appends on the first entering step, exactly once", async () => {
  const ctx = fakeCtx();
  const { agent, appended } = fakeAgent();
  const install = installDescriptorAppend(ctx, undefined, PAYLOAD);
  assert.equal(install.appended(), false);
  assert.equal(install.armed(), true);

  const decision = await firePreStep(ctx, agent, { kind: "enter" });
  assert.deepEqual(decision, { kind: "enter" }, "the waterfall decision must pass through untouched");
  assert.equal(install.appended(), true);
  assert.equal(install.path(), "pre-step");
  assert.equal(appended.length, 1);

  // 第二步(乃至更多步)不得重复追加:身份事件恰好一条
  await firePreStep(ctx, agent, { kind: "enter" });
  await firePreStep(ctx, agent, { kind: "enter" });
  assert.equal(appended.length, 1, "a second step must not append a second descriptor");
});

test("pre-step fallback appends nothing when the step is rejected", async () => {
  const ctx = fakeCtx();
  const { agent, appended } = fakeAgent();
  const install = installDescriptorAppend(ctx, undefined, PAYLOAD);
  await firePreStep(ctx, agent, { kind: "reject" });
  assert.equal(appended.length, 0);
  assert.equal(install.appended(), false);
});

test("neither path available reports armed=false (the observable corrupt signal)", () => {
  const ctx = fakeCtx({ withOn: false });
  const install = installDescriptorAppend(ctx, undefined, PAYLOAD);
  assert.equal(install.armed(), false, "no append point at all ⇒ the child is doomed to corrupt");
  assert.equal(install.appended(), false);
  assert.equal(install.path(), null);
});

test("a foreign second argument (not an Agent) still falls back instead of throwing", () => {
  const ctx = fakeCtx();
  for (const foreign of [{}, { session: {} }, { session: { append: 1 } }, null]) {
    const install = installDescriptorAppend(ctx, foreign, PAYLOAD);
    assert.equal(install.appended(), false);
    assert.equal(install.armed(), true);
  }
});

/* ── ② 静态防回归 ── */
test("the 2026-09-12 root-cause form must never come back", () => {
  // `childCtx.agent.` 是事故形态:ctx 上没有 agent 服务(服务名是 agents)
  assert.doesNotMatch(code, /childCtx\.agent\s*\./);
  assert.doesNotMatch(code, /childCtx\.agent\b/);
});

test("session event reads never assume one host generation's surface", () => {
  const sessionEvents = new Function(slice("function sessionEvents") + "\nreturn sessionEvents;")();
  const events = [{ type: "a" }];
  // 0.1.5-rc.2:类表面只剩 snapshotEvents()
  assert.deepEqual(sessionEvents({ snapshotEvents: () => events }), events);
  // 0.1.2-alpha.1 及更早:只有 getter events
  assert.deepEqual(sessionEvents({ events }), events);
  // 两者都在:文档化的 snapshotEvents() 优先
  assert.deepEqual(sessionEvents({ snapshotEvents: () => [{ type: "new" }], events }), [{ type: "new" }]);
  // 都没有 / 形状不对:空数组,绝不抛错(抛错会中断整条强化)
  assert.deepEqual(sessionEvents({}), []);
  assert.deepEqual(sessionEvents(undefined), []);
  assert.deepEqual(sessionEvents(null), []);
  assert.deepEqual(sessionEvents({ snapshotEvents: () => undefined, events: "nope" }), []);
  // 插件不再直接读裸属性
  assert.doesNotMatch(code, /agent\.session\.events\b/);
  assert.doesNotMatch(code, /handle\.agent\?\.session\?\.events/);
});

test("setup consumes the Agent second parameter and installs the append once", () => {
  assert.match(code, /const setup = \(childCtx, child\) => \{/);
  assert.match(code, /descriptorInstall = installDescriptorAppend\(childCtx, child, \{/);
  assert.match(code, /version: descriptorVersion,/);
  assert.match(code, /mode: "one-shot",/);
  assert.match(code, /provider: "prompt-enhancer",/);
});

/* 调用点行为覆盖:静态正则只能防「字面量改回 childCtx.agent」,防不住把第二参换成别的
 * 实参(如 childCtx)这类等价破坏。这里把 runEnhanceChild 里真实的 setup 闭包切出来跑,
 * 用假 childCtx(故意不带 .agent)+ 假 Agent,断言身份确实落到了 Agent 的 session 上。 */
const setupSlice = slice("const setup = (childCtx, child) => {", "\n  };\n");
const buildSetup = new Function(
  "installDescriptorAppend", "descriptorVersion", "READONLY_TOOLS", "ctx", "parent", "joinPreset", "persona", "modelCfg",
  "let descriptorInstall;\n" + setupSlice + "\nreturn { setup, install: () => descriptorInstall };",
);

test("the real setup closure appends through the Agent it was handed (behavioral)", () => {
  const ctx = { logger: { warn() {} } };
  const childCtx = fakeCtx(); // 真实 ctx 形态:没有 .agent
  const { agent, appended } = fakeAgent();
  // joinPreset=false + modelCfg=undefined ⇒ 只走身份追加那一支,不需要其它宿主服务
  const { setup, install } = buildSetup(installDescriptorAppend, 3, ["glob", "grep", "read"], ctx, { ctx: {} }, false, "persona", undefined);
  setup(childCtx, agent);
  assert.equal(appended.length, 1, "the descriptor must land on the Agent's session");
  assert.equal(appended[0].type, "subagent/descriptor");
  assert.deepEqual(appended[0].data, { version: 3, mode: "one-shot", provider: "prompt-enhancer", label: "提示词强化" });
  assert.equal(install().appended(), true);
  assert.equal(install().path(), "setup-arg");
  assert.equal(childCtx.listeners.size, 0, "no fallback needed when the Agent was handed over");
});

test("handing the ctx instead of the Agent degrades to the fallback, not to silence", () => {
  // 反向控制:把第二参写成 childCtx(等价于把落点写回 ctx)时,行为必须退化为 pre-step 兜底
  const ctx = { logger: { warn() {} } };
  const childCtx = fakeCtx();
  const { agent, appended } = fakeAgent();
  const { setup, install } = buildSetup(installDescriptorAppend, 3, ["glob", "grep", "read"], ctx, { ctx: {} }, false, "persona", undefined);
  setup(childCtx, childCtx);
  assert.equal(appended.length, 0, "setup-window append must not happen with a ctx as the child");
  assert.equal(install().armed(), true, "the pre-step fallback must still be armed");
  assert.equal(childCtx.listeners.size, 1);
});

test("silent failure is no longer possible: the descriptor is audited against real events", () => {
  assert.match(code, /enhance-child-descriptor-unarmed/);
  assert.match(code, /const descriptorEvents = events\.filter\(\(event\) => event\?\.type === "subagent\/descriptor"\)\.length;/);
  assert.match(code, /descriptorEvents === 0/);
  assert.match(code, /enhance-child-descriptor-final/);
});

/* ── ③ / ④ 宿主真实契约 ── */
// 宿主包探测集中在 tests/host-locate.mjs,与插件 findPackageDir 的策略同源:
// 桌面发行版目录名不固定,只按 DSH_HOME 上溯会让这些断言在真实宿主上静默 skip。
import { locateHostPkg } from "./host-locate.mjs";

const hostPkgDir = locateHostPkg("@deepseek-ai/dsh-subagent");
const hostSkip = hostPkgDir === undefined ? "host @deepseek-ai/dsh-subagent not locatable in this environment" : false;

test("host fold accepts the payload this plugin actually appends", { skip: hostSkip }, async () => {
  const mod = await import(pathToFileURL(join(hostPkgDir, "lib", "types", "descriptor.js")).href);
  const folded = mod.foldSubagentDescriptor([
    { type: "subagent/descriptor", seq: 1, time: 1, data: { ...PAYLOAD, version: mod.SUBAGENT_DESCRIPTOR_VERSION } },
  ]);
  assert.ok(folded !== undefined, "the appended payload must fold to an identity on this host");
  assert.equal(folded.mode, "one-shot");
  assert.equal(folded.provider, "prompt-enhancer");
  assert.equal(folded.label, "提示词强化");
});

test("identity projection: descriptor present -> identity, absent -> null (the corrupt verdict)", { skip: hostSkip }, async () => {
  const descriptorMod = await import(pathToFileURL(join(hostPkgDir, "lib", "types", "descriptor.js")).href);
  const projectionMod = await import(pathToFileURL(join(hostPkgDir, "lib", "types", "projection.js")).href);
  const def = projectionMod.subagentIdentityProjectionDefinition;
  const foldLog = (events) => {
    let state = def.init();
    for (const event of events) state = def.apply(state, event);
    return def.wire.view(state);
  };

  // 事故形态:整条日志没有任何 descriptor → 投影值 null ⇒ list-children 判 corrupt
  const broken = [
    { type: "session/end-seed", seq: 0, time: 1, data: {} },
    { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } },
  ];
  assert.equal(foldLog(broken), null, "a child without a descriptor folds to the null identity");

  // 修复形态:setup 窗口追加的 descriptor 参与折叠 → 拿到 one-shot 身份
  const { agent, appended } = fakeAgent();
  const install = installDescriptorAppend(fakeCtx(), agent, {
    ...PAYLOAD,
    version: descriptorMod.SUBAGENT_DESCRIPTOR_VERSION,
  });
  assert.equal(install.appended(), true);
  const events = [
    broken[0],
    ...appended.map((event, index) => ({ seq: index + 1, time: 10 + index, ...event })),
    { type: "turn/start", seq: appended.length + 2, time: 20, data: { turn: 1 } },
  ];
  const identity = foldLog(events);
  assert.notEqual(identity, null, "once the descriptor lands, the child is no longer corrupt");
  assert.equal(identity.mode, "one-shot");
  assert.equal(identity.label, "提示词强化");
  assert.equal(identity.seq, 1);
});

/* ── ⑤ 真实宿主 Session:落盘(写路径校验 + 信封 + seq)与折叠一起验 ── */
const sessionPkgDir = locateHostPkg("@deepseek-ai/dsh-session");
const sessionSkip = sessionPkgDir === undefined ? "host @deepseek-ai/dsh-session not locatable in this environment" : false;

test("real host Session: the installer's append lands in the log and folds to an identity", { skip: sessionSkip || hostSkip }, async () => {
  const { Session, SESSION_FORMAT_VERSION } = await import(pathToFileURL(join(sessionPkgDir, "lib", "index.js")).href);
  const descriptorMod = await import(pathToFileURL(join(hostPkgDir, "lib", "types", "descriptor.js")).href);
  const projectionMod = await import(pathToFileURL(join(hostPkgDir, "lib", "types", "projection.js")).href);
  const def = projectionMod.subagentIdentityProjectionDefinition;
  const childHeader = (id) => ({
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    cwd: "D:\\fixture",
    parentSession: "session-parent-fixture",
    origin: "subagent",
    delegationDepth: 1,
  });

  // 与 runEnhanceChild 同形:未播种(isSeeded:false)+ seed=[] + 子代理 meta
  const session = new Session("session-descriptor-append-fixture", [], childHeader("session-descriptor-append-fixture"));
  assert.equal(session.header.isSeeded, false);
  // 注意:本机 0.1.5-rc.2 的 Session 类没有 `events`(只到 0.1.2-rc.1 为止),
  // 插件因此走 sessionEvents() 兼容入口读事件,测试同样用文档化 API 读。
  assert.deepEqual(session.snapshotEvents().map((event) => event.type), ["session/end-seed"]);

  const install = installDescriptorAppend(fakeCtx(), { session }, {
    ...PAYLOAD,
    version: descriptorMod.SUBAGENT_DESCRIPTOR_VERSION,
  });
  assert.equal(install.appended(), true);
  assert.equal(install.path(), "setup-arg");

  // 写路径:信封/seq/冻结/可序列化校验全部由宿主 Session 执行过
  const own = session.ownEvents();
  assert.deepEqual(own.map((event) => event.type), ["session/end-seed", "subagent/descriptor"]);
  const descriptor = own[1];
  assert.equal(descriptor.seq, 1);
  assert.equal(Number.isSafeInteger(descriptor.time), true);
  assert.deepEqual({ ...descriptor.data }, { ...PAYLOAD, version: descriptorMod.SUBAGENT_DESCRIPTOR_VERSION });

  // 折叠:宿主身份投影必须给出 one-shot 身份(非 null),即 list-children 会产出 child 行
  let state = def.init();
  for (const event of session.snapshotEvents()) state = def.apply(state, event);
  const identity = def.wire.view(state);
  assert.notEqual(identity, null);
  assert.equal(identity.mode, "one-shot");
  assert.equal(identity.label, "提示词强化");
  assert.equal(identity.seq, 1);
  // 冷读路径的判据:身份 seq 必须 ≥ 继承前缀长度(未播种 = 0),否则同样判 corrupt
  assert.equal(session.inheritedEventCount, 0);
  assert.ok(identity.seq >= session.inheritedEventCount);

  // 反向:同一会话若跳过安装器(事故形态),投影回落到 null ⇒ corrupt
  const brokenSession = new Session("session-descriptor-absent-fixture", [], childHeader("session-descriptor-absent-fixture"));
  let brokenState = def.init();
  for (const event of brokenSession.snapshotEvents()) brokenState = def.apply(brokenState, event);
  assert.equal(def.wire.view(brokenState), null);
});
