import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const src = readFileSync(new URL("../src/client/index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = src.indexOf("const CODEX_PREDICTION_MODELS");
const end = src.indexOf("/* ═══════════════ 平台快照 store", start);
if (start < 0 || end < 0) throw new Error("client suggestion state markers missing");
const sandbox = new Function(src.slice(start, end) + "\nreturn { codexPredictionOwns, suggestionConsumed, suggestionView, suggestionSync };")();

const base = {
  enabled: true,
  busy: false,
  empty: true,
  attachmentCount: 0,
  composerPhase: "plain",
  turnKey: "s:3",
  dismissed: false,
  consumed: false,
  codexOwned: false,
  phase: "idle",
  suggestion: "",
  loadedKey: "s:3",
};

test("codex ownership is the provider plus a prediction-capable model", () => {
  const owned = { provider: "openai-codex", model: "gpt-6.1-sol" };
  assert.equal(sandbox.codexPredictionOwns(owned), true);
  assert.equal(sandbox.codexPredictionOwns({ ...owned, model: "gpt-6-astra" }), true);
  assert.equal(sandbox.codexPredictionOwns({ ...owned, model: "gpt-6.1-terra" }), true);
  assert.equal(sandbox.codexPredictionOwns({ ...owned, provider: "deepseek" }), false);
  assert.equal(sandbox.codexPredictionOwns({ ...owned, model: "gpt-5.4" }), false);
  assert.equal(sandbox.codexPredictionOwns({ provider: "openai-codex", model: "gpt-6.1-sol", active: false }), true);
});

test("an edited accepted suggestion is consumed", () => {
  assert.equal(sandbox.suggestionConsumed("继续", "继续，并补测试"), true);
  assert.equal(sandbox.suggestionConsumed("继续", "继续"), false);
  assert.equal(sandbox.suggestionConsumed("继续", "   "), false);
  assert.equal(sandbox.suggestionConsumed("", "别的内容"), false);
});

test("ordinary settled turn requests and then shows without focus", () => {
  assert.deepEqual(sandbox.suggestionView(base), { request: true, showText: false, placeholder: "loading" });
  assert.deepEqual(sandbox.suggestionView({ ...base, phase: "ready", suggestion: "下一步" }), {
    request: false, showText: true, placeholder: "hidden",
  });
});

test("a suggestion from the previous turn is not shown after sending", () => {
  assert.deepEqual(sandbox.suggestionView({ ...base, phase: "ready", suggestion: "旧建议", loadedKey: "s:2" }), {
    request: true, showText: false, placeholder: "loading",
  });
});

test("a shown suggestion is held instead of being cleared", () => {
  const ready = { ...base, phase: "ready", suggestion: "下一步" };
  const view = sandbox.suggestionView(ready);
  assert.equal(view.showText, true);
  assert.equal(sandbox.suggestionSync({ turnKey: base.turnKey, loadedKey: base.turnKey, request: view.request }), "hold");
});

test("a fresh turn with nothing loaded requests instead of stalling", () => {
  // 回归:首回合之前 loadedKey 为空串、turnKey 非空,旧实现判成 clear,永远不会发请求,
  // 界面就一直停在加载态。
  assert.equal(sandbox.suggestionSync({ turnKey: "s:3", loadedKey: "", request: true }), "request");
  assert.equal(sandbox.suggestionSync({ turnKey: "s:3", loadedKey: "", request: false }), "hold");
  assert.equal(sandbox.suggestionSync({ turnKey: "", loadedKey: "", request: false }), "hold");
});

test("an empty or superseded turn clears, an idle turn requests", () => {
  const idle = sandbox.suggestionView(base);
  assert.equal(sandbox.suggestionSync({ turnKey: base.turnKey, loadedKey: base.turnKey, request: idle.request }), "request");
  assert.equal(sandbox.suggestionSync({ turnKey: "", loadedKey: "s:3", request: false }), "clear");
  assert.equal(sandbox.suggestionSync({ turnKey: "s:4", loadedKey: "s:3", request: true }), "clear");
});

test("codex-owned, dismissed, busy, and failed turns stay quiet", () => {
  for (const patch of [{ codexOwned: true }, { dismissed: true }, { busy: true }, { consumed: true }, { phase: "failed" }]) {
    assert.deepEqual(sandbox.suggestionView({ ...base, ...patch }), {
      request: false, showText: false, placeholder: "normal",
    });
  }
});
