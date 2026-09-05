// 「转换英文」开关行为测试(从 src/index.js 截取纯函数段执行)
// 覆盖:persona 语言规则切换 / payload 英文输出指令 / 参考文件节中英文标题的
// 宿主兜底(存在性校验、中档压缩、低档剥离)/ 技能引用节英文回填。
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const personaFn = slice("function enhancerPersona", "\n}\n") + "\n}\n";
const payloadFn = slice("function buildPayload", "\n}\n") + "\n}\n";
const gesture = slice("const SKILL_GESTURE", ";") + ";";
const extractFn = slice("function extractSkillNames", "\n}\n") + "\n}\n";
const ensureFn = slice("function ensureSkillReferences", "\n}\n") + "\n}\n";
const compactFn = slice("function compactMediumReferences", "\n}\n") + "\n}\n";
const stripFn = slice("function stripReferences", "\n}\n") + "\n}\n";
const sandbox = new Function(
  personaFn + "\n" + payloadFn + "\n" + gesture + "\n" + extractFn + "\n" + ensureFn + "\n" + compactFn + "\n" + stripFn
  + "\nreturn { enhancerPersona, buildPayload, extractSkillNames, ensureSkillReferences, compactMediumReferences, stripReferences };",
)();
const { enhancerPersona, buildPayload, extractSkillNames, ensureSkillReferences, compactMediumReferences, stripReferences } = sandbox;

// sanitizeReferences 依赖 node:path/node:fs,经 Function 参数注入
const sanitizeFn = slice("function sanitizeReferences", "\n}\n") + "\n}\n";
const sanitizeSandbox = new Function("resolve", "existsSync", sanitizeFn + "\nreturn sanitizeReferences;")(resolve, existsSync);
const sanitizeReferences = sanitizeSandbox;

/* ═══════════════ persona 语言规则切换 ═══════════════ */

test("persona(zh):保持输入语言,中文节标题", () => {
  const zh = enhancerPersona(false);
  assert.ok(zh.includes("1. 保持用户输入的语言(中文进中文出、英文进英文出),禁止翻译。"));
  assert.ok(zh.includes("「## 参考文件」"));
  assert.ok(zh.includes("「## 技能引用」"));
  assert.ok(!zh.includes("Reference Files"));
});

test("persona(en):一律英文输出,英文节标题", () => {
  const en = enhancerPersona(true);
  assert.ok(en.includes("1. 输出语言:无论原始提示词是什么语言,强化结果一律使用英文书写"));
  assert.ok(en.includes("「## Reference Files」"));
  assert.ok(en.includes("「## Skill References」"));
  assert.ok(en.includes("Goal / Context (if any) / Steps / Constraints / Acceptance criteria."));
  assert.ok(!en.includes("「## 参考文件」"));
  assert.ok(!en.includes("保持用户输入的语言"));
});

test("persona:两种模式共享规则 9/10(记号原样保留 + 意图先行)", () => {
  for (const flag of [false, true]) {
    const p = enhancerPersona(flag);
    assert.ok(p.includes("禁止删除"), "rule 9 shared");
    assert.ok(p.includes("意图先行"), "rule 10 shared");
    assert.ok(p.includes("禁止臆测或猜测路径"), "refs rule shared");
  }
});

/* ═══════════════ payload 英文输出指令 ═══════════════ */

test("payload:开关关闭时无英文输出指令(原行为)", () => {
  const text = buildPayload("帮我加个按钮", "ctx", "/work", "medium", []);
  assert.ok(!text.includes("本次输出语言"));
  assert.ok(text.includes("按你的系统指令强化上面的原始提示词"));
});

test("payload:开关开启时追加英文输出指令(含英文节标题)", () => {
  const text = buildPayload("help me add a button", "ctx", "/work", "high", ["tdd"], true);
  assert.ok(text.includes("【本次输出语言:英文】"));
  assert.ok(text.includes("「## Reference Files」"));
  assert.ok(text.includes("「## Skill References」"));
  assert.ok(text.includes("【Skill 引用(必须原样保留)】"), "skill 约束节不受语言开关影响");
});

test("payload:英文指令与强度指令并存", () => {
  const low = buildPayload("d", "", "", "low", [], true);
  assert.ok(low.includes("【本次强度:低】") && low.includes("【本次输出语言:英文】"));
});

/* ═══════════════ 参考文件节:英文标题同样受宿主兜底约束 ═══════════════ */

const TESTS_DIR = join(dirname(fileURLToPath(import.meta.url)));

test("sanitize:英文标题下臆造路径仍被剔除,真实路径保留", () => {
  const text = [
    "Goal: something",
    "## Reference Files",
    "- truncation.test.mjs — a real file note",
    "- definitely-not-here.md — a fake path",
    "## Next Section",
    "tail",
  ].join("\n");
  const result = sanitizeReferences(text, TESTS_DIR);
  assert.equal(result.removed, 1);
  assert.ok(result.text.includes("- truncation.test.mjs — a real file note"));
  assert.ok(!result.text.includes("definitely-not-here.md"));
  assert.ok(result.text.includes("## Next Section"));
});

test("sanitize:英文标题全臆造时整节删除", () => {
  const text = "body\n## Reference Files\n- fake1.md — a\n- fake2.md — b\n";
  const result = sanitizeReferences(text, TESTS_DIR);
  assert.ok(result.removed >= 2);
  assert.ok(!result.text.includes("Reference Files"), "整节应被删除");
  assert.ok(result.text.includes("body"));
});

test("sanitize:中文标题行为不变(回归)", () => {
  const text = "## 参考文件\n- truncation.test.mjs — 真实文件\n- ghost.md — 不存在\n";
  const result = sanitizeReferences(text, TESTS_DIR);
  assert.equal(result.removed, 1);
  assert.ok(result.text.includes("- truncation.test.mjs — 真实文件"));
  assert.ok(!result.text.includes("ghost.md"));
});

test("compactMedium:英文标题节内只保留路径", () => {
  const text = [
    "Body text",
    "## Reference Files",
    "- src/a.js — some note",
    "- src/b.js — another note",
    "```",
    "excerpts here",
    "```",
    "## Next",
    "end",
  ].join("\n");
  const out = compactMediumReferences(text);
  assert.ok(out.includes("## Reference Files"));
  assert.ok(out.includes("- src/a.js"));
  assert.ok(out.includes("- src/b.js"));
  assert.ok(!out.includes("some note"));
  assert.ok(!out.includes("excerpts here"));
  assert.ok(out.includes("## Next"));
});

test("strip:英文标题节整节删除(低档强度兜底)", () => {
  const text = "intro\n## Reference Files\n- a.md — note\n\n## Next\nend";
  const out = stripReferences(text);
  assert.ok(!out.includes("Reference Files"));
  assert.ok(!out.includes("a.md"));
  assert.ok(out.includes("intro") && out.includes("## Next") && out.includes("end"));
});

/* ═══════════════ 技能引用回填:英文模式节标题 ═══════════════ */

test("ensureSkillReferences:英文模式回填「## Skill References」节", () => {
  const result = ensureSkillReferences("English body", ["tdd"], true);
  assert.equal(result.added, 1);
  assert.ok(result.text.includes("## Skill References"));
  assert.ok(!result.text.includes("## 技能引用"));
  assert.ok(result.text.includes("- /tdd"));
});

test("ensureSkillReferences:缺省仍用中文节标题(回归)", () => {
  const result = ensureSkillReferences("中文正文", ["tdd"]);
  assert.ok(result.text.includes("## 技能引用"));
  assert.ok(!result.text.includes("## Skill References"));
});

test("ensureSkillReferences:回填的英文节能被再次提取(宿主全文扫描可命中)", () => {
  const result = ensureSkillReferences("body", ["tdd", "grill"], true);
  assert.deepEqual(extractSkillNames(result.text), ["tdd", "grill"]);
});