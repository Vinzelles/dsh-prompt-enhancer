// 输出截断检测行为测试(从 src/index.js 截取纯函数段执行)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n"); // CRLF 归一:工作区行尾不锁定截取 marker

function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error("marker not found: " + startMarker);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error("end marker not found: " + endMarker);
  return src.slice(start, end);
}

const textOfBlocksFn = slice("function textOfBlocks", "\n}\n") + "\n}\n";
const cleanFn = slice("function cleanAssistantText", "\n}\n") + "\n}\n";
const truncateFn = slice("function childOutputTruncated", "\n}\n") + "\n}\n";
const sandbox = new Function(textOfBlocksFn + "\n" + cleanFn + "\n" + truncateFn + "\nreturn { childOutputTruncated };")();
const { childOutputTruncated } = sandbox;

// 事件构造器(与宿主会话记录形状一致:assistant/chunk 的 data.chunk 为 LLM 原始 chunk)
const msg = (text) => ({ type: "assistant/message", data: { message: { content: [{ type: "text", text }] } } });
const finish = (kind) => ({ type: "assistant/chunk", data: { chunk: { type: "finish", reason: { kind } } } });

test("normal stop finish -> not truncated", () => {
  assert.equal(childOutputTruncated([finish("stop"), msg("完成")]), false);
});

test("max-tokens finish on the final text step -> truncated", () => {
  assert.equal(childOutputTruncated([finish("max-tokens"), msg("半截文本")]), true);
});

test("tool-calls steps before a max-tokens final step -> truncated", () => {
  assert.equal(childOutputTruncated([finish("tool-calls"), msg("中间步"), finish("max-tokens"), msg("最终文本")]), true);
});

test("final step is tool-calls -> not truncated", () => {
  assert.equal(childOutputTruncated([finish("max-tokens"), msg("被截的中段"), finish("tool-calls"), msg("继续")]), false);
});

test("trailing empty-text message is skipped (target = last non-empty)", () => {
  assert.equal(childOutputTruncated([finish("stop"), msg("正常"), finish("max-tokens"), msg("   ")]), false);
});

test("max-tokens step with empty text before a clean final step -> not truncated", () => {
  assert.equal(childOutputTruncated([finish("max-tokens"), msg(""), finish("stop"), msg("最终")]), false);
});

test("no finish chunk before target message -> not truncated (unknown, fail-open to no warning)", () => {
  assert.equal(childOutputTruncated([msg("直接有文本")]), false);
});

test("no assistant/message at all -> not truncated", () => {
  assert.equal(childOutputTruncated([finish("max-tokens")]), false);
});

test("empty events -> not truncated", () => {
  assert.equal(childOutputTruncated([]), false);
});

test("non-matching events interleaved -> still finds the pair", () => {
  const noise = { type: "user/message", data: {} };
  assert.equal(childOutputTruncated([noise, finish("max-tokens"), msg("最终文本")]), true);
});