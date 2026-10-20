// 客户端 store 引擎解析契约(0.1.1 / 0.1.2+ 双代宿主)。
// 事故根因:工厂顶部 `const { createSnapshotStore } = require("@deepseek-ai/dsh-client-runtime/client")`
// 是静态解析——0.1.2 删除了该包,client-modules 模块表答不上来就抛
// 「require(...) missed the module table」,整条 loader entry 导入失败(启动页
// Failed to load plugins),插件全部功能不加载。本机曾靠手工给内核打 compat 补丁撑着,
// 内核一重装/升级(profile 的 node_modules 是指向内核的 junction)立即复发。
// 因此引擎必须运行时逐条查表 + 本地兜底。
// 四段:① 0.1.2 宿主命中 store 种子;② 0.1.1 宿主回退 runtime 包;③ 两条都缺退回本地实现
// (observable 契约 getSnapshot/subscribe/update/set 行为);④ 静态防回归 + 产物同源。
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const src = readFileSync(new URL("../src/client/index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n"); // CRLF 归一(同 limits.test.mjs)
const lib = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error("marker not found: " + startMarker);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error("end marker not found: " + endMarker);
  return src.slice(start, end);
}

// 解析段是工厂体内的两个函数声明 + const 绑定:截取后注入假 require/console 即可实跑。
const resolverBlock = slice("    function fallbackSnapshotStore(init) {", "    const createSnapshotStore = resolveCreateSnapshotStore();");
const sandbox = new Function(
  "require", "console",
  resolverBlock + "\n    return { resolveCreateSnapshotStore, fallbackSnapshotStore };",
);

/** 造一个平台引擎(只需 createSnapshotStore 契约)。 */
function platformEngine(tag) {
  const engine = {
    tag,
    createSnapshotStore: (init) => ({ tag, getSnapshot: () => init, subscribe: () => () => {}, update: () => {}, set: () => {} }),
  };
  return engine;
}

/** 用给定的模块表跑一遍解析;表里没有的拼写照模块表语义抛错。 */
function resolveWith(table) {
  const warnings = [];
  const { resolveCreateSnapshotStore, fallbackSnapshotStore } = sandbox(
    (specifier) => {
      if (!(specifier in table)) {
        throw new Error('client-modules: require("' + specifier + '") missed the module table — not a platform seed word');
      }
      return table[specifier];
    },
    { warn: (...args) => { warnings.push(args); } },
  );
  return { resolveCreateSnapshotStore, fallbackSnapshotStore, warnings };
}

/* ── ① 0.1.2 宿主 ── */
test("0.1.2 宿主:命中 @deepseek-ai/dsh-client-store 平台种子", () => {
  const engine = platformEngine("store");
  const { resolveCreateSnapshotStore, warnings } = resolveWith({ "@deepseek-ai/dsh-client-store": engine });
  assert.equal(resolveCreateSnapshotStore(), engine.createSnapshotStore);
  assert.equal(warnings.length, 0);
});

test("两个拼写都在(打过 compat 补丁的内核):仍取平台 store 引擎,不取别名", () => {
  const storeEngine = platformEngine("store");
  const legacyEngine = platformEngine("legacy");
  const { resolveCreateSnapshotStore } = resolveWith({
    "@deepseek-ai/dsh-client-store": storeEngine,
    "@deepseek-ai/dsh-client-runtime/client": legacyEngine,
  });
  assert.equal(resolveCreateSnapshotStore(), storeEngine.createSnapshotStore);
});

/* ── ② 0.1.1 宿主 ── */
test("0.1.1 宿主:store 拼写缺失时回退 runtime 包,且不告警", () => {
  const engine = platformEngine("legacy");
  const { resolveCreateSnapshotStore, warnings } = resolveWith({ "@deepseek-ai/dsh-client-runtime/client": engine });
  assert.equal(resolveCreateSnapshotStore(), engine.createSnapshotStore);
  assert.equal(warnings.length, 0);
});

test("store 引擎导出残缺(无 createSnapshotStore)时继续下一条,不误用", () => {
  const engine = platformEngine("legacy");
  const { resolveCreateSnapshotStore } = resolveWith({
    "@deepseek-ai/dsh-client-store": { tag: "store", defineStore: () => {} },
    "@deepseek-ai/dsh-client-runtime/client": engine,
  });
  assert.equal(resolveCreateSnapshotStore(), engine.createSnapshotStore);
});

/* ── ③ 两条都缺:本地兜底 ── */
test("两条拼写都缺失:退回本地实现并告警,不抛错", () => {
  const { resolveCreateSnapshotStore, fallbackSnapshotStore, warnings } = resolveWith({});
  assert.equal(resolveCreateSnapshotStore(), fallbackSnapshotStore);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /prompt-enhancer/);
});

test("本地兜底的 observable 契约(host hooks 只要求 getSnapshot/subscribe 一对)", () => {
  const { fallbackSnapshotStore } = resolveWith({});
  const store = fallbackSnapshotStore({ busy: false, error: null });
  assert.deepEqual(store.getSnapshot(), { busy: false, error: null });

  const seen = [];
  const off = store.subscribe(() => { seen.push(store.getSnapshot().busy); });
  store.update((state) => { state.busy = true; });
  assert.deepEqual(store.getSnapshot(), { busy: true, error: null });
  assert.deepEqual(seen, [true]);

  store.set({ busy: false, error: "x" });
  assert.deepEqual(store.getSnapshot(), { busy: false, error: "x" });
  assert.deepEqual(seen, [true, false]);

  off();
  store.update((state) => { state.busy = true; });
  assert.deepEqual(seen, [true, false], "退订后不得再通知");
  assert.equal(store.getSnapshot().busy, true);
});

/* ── ④ 静态防回归 + 产物同源 ── */
test("静态防回归:引擎只经变量查表,不得出现字面量 require(静态解析即整插件失败)", () => {
  for (const specifier of ["@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-runtime/client"]) {
    assert.equal(src.includes('require("' + specifier + '")'), false, "字面量 require 会退回静态解析: " + specifier);
  }
  assert.ok(src.includes("for (const specifier of candidates)"), "必须逐条遍历候选表");
  assert.ok(/try \{[\s\S]{0,200}?require\(specifier\)[\s\S]{0,200}?\} catch \(error\) \{/.test(src), "查表必须 try/catch 兜底");

  const table = /const candidates = \[([^\]]*)\]/.exec(src);
  assert.ok(table !== null, "缺少 candidates 候选表");
  // 顺序即优先级:先当前平台拼写(0.1.2+ 种子),再老宿主回退。
  assert.deepEqual([...table[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]), [
    "@deepseek-ai/dsh-client-store",
    "@deepseek-ai/dsh-client-runtime/client",
  ]);
});

test("产物同源:lib/client.js 与 src/client/index.js 一致(build:client 是纯拷贝)", () => {
  assert.equal(lib.replace(/\r\n/g, "\n"), src);
});
