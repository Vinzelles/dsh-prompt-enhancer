// Skill 引用保留功能的行为测试(从 src/index.js 截取纯函数段执行)
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n"); // CRLF 归一:工作区行尾不锁定截取 marker

function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error("marker not found: " + startMarker);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error("end marker not found: " + endMarker);
  return src.slice(start, end);
}

const gesture = slice("const SKILL_GESTURE", ";") + ";";
const extractFn = slice("function extractSkillNames", "\n}\n") + "\n}\n";
const ensureFn = slice("function ensureSkillReferences", "\n}\n") + "\n}\n";
const compactFn = slice("function compactMediumReferences", "\n}\n") + "\n}\n";
const stripFn = slice("function stripReferences", "\n}\n") + "\n}\n";
const sandbox = new Function(
  gesture + "\n" + extractFn + "\n" + ensureFn + "\n" + compactFn + "\n" + stripFn
  + "\nreturn { extractSkillNames, ensureSkillReferences, compactMediumReferences, stripReferences };",
)();
const { extractSkillNames, ensureSkillReferences, compactMediumReferences, stripReferences } = sandbox;

let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed += 1;
    console.log("FAIL", name, "\n  actual:", JSON.stringify(actual), "\n  expected:", JSON.stringify(expected));
  } else console.log("ok  ", name);
};

// ── 提取(与宿主 dsh-tool-skill SKILL_GESTURE 同文法)──
check("basic", extractSkillNames("请用 /tdd 流程修复 /systematic-debugging 问题"), ["tdd", "systematic-debugging"]);
check("start-of-line", extractSkillNames("/code-review this"), ["code-review"]);
check("multiline", extractSkillNames("第一行\n/src-hunter 挖洞"), ["src-hunter"]);
check("no-match-mid-word", extractSkillNames("路径 docs/readme.md 与 abc/tdd 不算"), []);
check("host-parity-tddx", (() => {
  // 宿主原文正则逐字符对照:同样命中 /tddx(kebab 合法名)
  const HOST = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;
  return [..."访问 /tddx 后缀".matchAll(HOST)].map((m) => m[2]);
})(), extractSkillNames("访问 /tddx 后缀"));
check("dedupe-order", extractSkillNames("/b then /a then /b"), ["b", "a"]);
check("punctuation-boundary", extractSkillNames("先 /tdd 再 /grill"), ["tdd", "grill"]);
// 与宿主的奇偶一致性:全角逗号紧跟记号时,本实现与宿主同样不命中(不误报差异)
check("host-parity-fullwidth-comma", extractSkillNames("先 /tdd,再 /grill。"), (() => {
  const HOST = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;
  return [..."先 /tdd,再 /grill。".matchAll(HOST)].map((m) => m[2]);
})());
check("empty", extractSkillNames(""), []);

// ── 兜底回填 ──
check("noop-all-kept", ensureSkillReferences("用 /tdd 做", ["tdd"]).added, 0);
check("noop-text-preserved", ensureSkillReferences("用 /tdd 做", ["tdd"]).text, "用 /tdd 做");
check("backfill-all", ensureSkillReferences("重构此模块", ["tdd"]), {
  text: "重构此模块\n\n## 技能引用\n以下记号是宿主平台的技能(skills)调用标记,发送后会由宿主注入对应技能的完整说明,不得删除、改写或翻译:\n- /tdd\n",
  added: 1,
  requested: 1,
  mode: "all",
});
check("backfill-partial-added", ensureSkillReferences("按 /tdd 但丢了 grill", ["tdd", "grill"]).added, 1);
check("backfill-partial-mode", ensureSkillReferences("按 /tdd 但丢了 grill", ["tdd", "grill"]).mode, "partial");
check("trailing-whitespace-trimmed", ensureSkillReferences("正文   \n\n", ["tdd"]).text.startsWith("正文\n\n## 技能引用"), true);

// 回填节能被再次提取(= 宿主全文扫描可命中)
const restored = ensureSkillReferences("正文", ["tdd", "grill"]);
check("restored-reextractable", extractSkillNames(restored.text), ["tdd", "grill"]);

// ── 与强度兜底器互不干扰 ──
const med = compactMediumReferences(restored.text); // 中档压缩只动「## 参考文件」节
check("medium-preserves-skill-section", extractSkillNames(med), ["tdd", "grill"]);
check("low-preserves-skill-section", extractSkillNames(stripReferences(restored.text)), ["tdd", "grill"]);

console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
process.exit(failed === 0 ? 0 : 1);
