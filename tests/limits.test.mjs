// 草稿长度上限行为测试(从 src/index.js 截取纯函数段执行)
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

const limitConst = slice("const MAX_DRAFT_CHARS", ";\n") + ";\n";
const limitFn = slice("function draftLimitError", "\n}\n") + "\n}\n";
const sandbox = new Function(limitConst + "\n" + limitFn + "\nreturn { draftLimitError, MAX_DRAFT_CHARS };")();
const { draftLimitError, MAX_DRAFT_CHARS } = sandbox;

test("limit constant is 200000 chars", () => assert.equal(MAX_DRAFT_CHARS, 200_000));
test("exactly at the limit -> accepted (null)", () => {
  assert.equal(draftLimitError("x".repeat(MAX_DRAFT_CHARS)), null);
});
test("limit + 1 -> rejected with the limit in the message", () => {
  const error = draftLimitError("x".repeat(MAX_DRAFT_CHARS + 1));
  assert.ok(error !== null);
  assert.ok(error.includes(String(MAX_DRAFT_CHARS)));
});
test("short draft -> accepted", () => assert.equal(draftLimitError("给登录页加个记住我"), null));
test("empty draft -> no limit error (empty handled separately upstream)", () => assert.equal(draftLimitError(""), null));