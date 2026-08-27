import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(ROOT, "promo", "narration.txt");

test("locked TTS narration covers documented selling points and no invented features", () => {
  assert.ok(existsSync(SCRIPT_PATH), "promo/narration.txt must exist — this is the script fed to TTS");
  const script = readFileSync(SCRIPT_PATH, "utf8");
  assert.notEqual(script.trim(), "", "narration script is not empty");

  const required = [
    ["强化 button", "强化"],
    ["还原 button", "还原"],
    ["intensity 低", "低"],
    ["intensity 中", "中"],
    ["intensity 高", "高"],
    ["零污染 execution", "零污染"],
    ["path existence check", /路径校验|存在性/],
    ["cancel / abort", /取消|中止/],
    [
      "one-line install",
      "dsh plugin --profile web add github:Vinzelles/dsh-prompt-enhancer",
    ],
    ["before-draft example", "给登录页加个记住我"],
    ["after-enhanced-draft example", "为登录页增加记住我"],
    ["manual send, not auto-send", "不自动发送"],
  ];

  for (const [label, needle] of required) {
    if (typeof needle === "string") {
      assert.ok(script.includes(needle), `missing beat: ${label} (${needle})`);
    } else {
      assert.ok(needle.test(script), `missing beat: ${label} (${needle})`);
    }
  }

  const banned = [
    ["auto-send", /自动发送(?!)/],
    ["injects into main history", /写入主对话|注入主对话|进入主对话历史/],
  ];
  assert.doesNotMatch(script, /会自动发送|自动发出/);
  assert.doesNotMatch(script, /写入主对话|注入主对话|进入主对话历史/);
});
