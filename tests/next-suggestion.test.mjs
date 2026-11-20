// 下一轮建议的纯函数契约:上下文窗口、单条清洗、长度上限。
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error("marker not found: " + startMarker);
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error("end marker not found: " + endMarker);
  return src.slice(start, end);
}

const caps = slice("const CONTEXT_CHAR_BUDGET", "const READONLY_TOOLS");
const clean = slice("function cleanAssistantText", "\n}\n") + "\n}\n";
const helpers = slice("const SUGGESTION_MESSAGE_CAP", "async function withTimeout");
const sandbox = new Function(caps + "\n" + clean + "\n" + helpers + "\nreturn { suggestionContext, normalizeSuggestion, SUGGESTION_MESSAGE_CAP, SUGGESTION_CHAR_CAP };")();

test("keeps only user and assistant text, newest 12", () => {
  const messages = [];
  for (let i = 0; i < 15; i += 1) messages.push({ role: i % 2 === 0 ? "user" : "assistant", text: "m" + i });
  messages.push({ role: "tool", text: "hidden" }, { role: "user", text: "   " }, null);
  const context = sandbox.suggestionContext(messages);
  assert.equal(context.includes("hidden"), false);
  assert.equal(context.startsWith("[助手] m3"), true);
  assert.equal(context.endsWith("[用户] m14"), true);
  assert.equal(context.split("\n").length, sandbox.SUGGESTION_MESSAGE_CAP);
});

test("folds one oversized message and respects the character budget", () => {
  const huge = "字".repeat(4000);
  const context = sandbox.suggestionContext([
    { role: "user", text: huge },
    { role: "assistant", text: "短回复" },
  ]);
  assert.match(context, /已折叠/);
  assert.ok(context.length <= 24_000);
  assert.match(context, /短回复$/);
});

test("returns empty context for malformed input", () => {
  assert.equal(sandbox.suggestionContext(undefined), "");
  assert.equal(sandbox.suggestionContext([{ role: "user" }]), "");
});

test("normalizes fences, quotes, lists, and whitespace", () => {
  assert.equal(sandbox.normalizeSuggestion("```text\n继续实现\n```"), "继续实现");
  assert.equal(sandbox.normalizeSuggestion("\"  下一句  \""), "下一句");
  assert.equal(sandbox.normalizeSuggestion("「核对测试」"), "核对测试");
  assert.equal(sandbox.normalizeSuggestion("1. 第一条\n2. 第二条"), "第一条");
  assert.equal(sandbox.normalizeSuggestion("一行\n\n两行"), "一行 两行");
});

test("strips fake tool-call text and caps length", () => {
  const noisy = "可用建议<tool_call>name</tool_call>\n" + "长".repeat(700);
  const value = sandbox.normalizeSuggestion(noisy);
  assert.equal(value.includes("tool_call"), false);
  assert.equal(value.length, sandbox.SUGGESTION_CHAR_CAP);
  assert.equal(value.startsWith("可用建议"), true);
});

test("empty model output stays empty", () => {
  assert.equal(sandbox.normalizeSuggestion("   "), "");
  assert.equal(sandbox.normalizeSuggestion(null), "");
});
