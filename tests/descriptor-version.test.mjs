// subagent/descriptor 版本契约回归测试(0.1.1 = v2 / 0.1.2+ = v3 双代宿主)。
// 事故根因:宿主 0.1.2 把 SUBAGENT_DESCRIPTOR_VERSION 从 2 升到 3,插件硬编码旧值 →
// foldSubagentDescriptor 判为无身份 → 子代理目录「会话记录损坏」。反向同理:硬编码 3
// 会砸 0.1.1 用户。因此插件按三级通道解析宿主真实契约(import → 文件扫描 → 包 semver),
// 兜底 pin 仅在全通道失败(宿主包整体定位不到)时生效。
// 四段:① 扫描/semver 推断纯函数;② resolveDescriptorVersion 通道链(v2 fixture 实证);
// ③ 静态防回归(不得硬编码 stamp、锚点齐全);④ 宿主契约验证(本机真实宿主 fold 语义)。
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n"); // CRLF 归一(同 limits.test.mjs)

function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error("marker not found: " + startMarker);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error("end marker not found: " + endMarker);
  return src.slice(start, end);
}

/* ── ① 纯函数:文件扫描 & 包 semver 推断 ── */
const scanFn = slice("function scanDescriptorVersionFromFile", "\n}\n") + "\n}\n";
const semverFn = slice("function descriptorVersionFromPackageJson", "\n}\n") + "\n}\n";
const resolverFn = slice("async function resolveDescriptorVersion", "\n}\n") + "\n}\n";
const sandbox = new Function(
  "readFileSync", "join", "pathToFileURL",
  scanFn + semverFn + resolverFn +
  "\nreturn { scanDescriptorVersionFromFile, descriptorVersionFromPackageJson, resolveDescriptorVersion };",
)(readFileSync, join, pathToFileURL);
const { scanDescriptorVersionFromFile, descriptorVersionFromPackageJson, resolveDescriptorVersion } = sandbox;

/** 造假宿主包目录:descriptor.js 内容 + package.json version 可控。 */
function fixturePkg({ descriptorText, noDescriptorFile = false, version = "0.1.2-rc.1" }) {
  const dir = mkdtempSync(join(tmpdir(), "dpe-desc-"));
  const typesDir = join(dir, "lib", "types");
  mkdirSync(typesDir, { recursive: true });
  if (!noDescriptorFile) {
    writeFileSync(join(typesDir, "descriptor.js"), descriptorText, "utf8");
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-subagent", version }), "utf8");
  return dir;
}
function withFixture(options, run) {
  const dir = fixturePkg(options);
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("scan extracts the version constant (v2 and v3 and future)", () => {
  withFixture({ descriptorText: "export const SUBAGENT_DESCRIPTOR_VERSION = 3;\n" }, (dir) => {
    assert.equal(scanDescriptorVersionFromFile(dir), 3);
  });
  withFixture({ descriptorText: "export const SUBAGENT_DESCRIPTOR_VERSION = 2;\n" }, (dir) => {
    assert.equal(scanDescriptorVersionFromFile(dir), 2);
  });
});

test("scan returns undefined when file/constant missing or value invalid", () => {
  const empty = mkdtempSync(join(tmpdir(), "dpe-desc-none-"));
  try {
    assert.equal(scanDescriptorVersionFromFile(empty), undefined); // 无 lib/types/descriptor.js
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  withFixture({ descriptorText: "export const NO_VERSION = 3;\n" }, (dir) => {
    assert.equal(scanDescriptorVersionFromFile(dir), undefined); // 无该常量
  });
  withFixture({ descriptorText: "export const SUBAGENT_DESCRIPTOR_VERSION = 0;\n" }, (dir) => {
    assert.equal(scanDescriptorVersionFromFile(dir), undefined); // 非法版本
  });
});

// semver 边界为 2026-09-07 对 npm 发布物实证:0.1.0-rc.8/0.1.1-rc.1/0.1.1-rc.2 = 2;
// 0.1.2-alpha.2/0.1.2-alpha.5/0.1.2-rc.1 = 3。
test("semver inference: every 0.1.1-line version maps to v2 contract", () => {
  for (const version of ["0.1.0-rc.8", "0.1.1-rc.1", "0.1.1-rc.2"]) {
    withFixture({ descriptorText: "garbage {{{ not parsable", version }, (dir) => {
      assert.equal(descriptorVersionFromPackageJson(dir), 2, version + " must map to 2");
    });
  }
});

test("semver inference: 0.1.2+ and later majors map to v3 contract", () => {
  for (const version of ["0.1.2-alpha.2", "0.1.2-rc.1", "0.2.0", "1.0.0"]) {
    withFixture({ descriptorText: "garbage {{{ not parsable", version }, (dir) => {
      assert.equal(descriptorVersionFromPackageJson(dir), 3, version + " must map to 3");
    });
  }
});

test("semver inference: unparseable version -> undefined (final pin takes over)", () => {
  withFixture({ descriptorText: "x", version: "nightly" }, (dir) => {
    assert.equal(descriptorVersionFromPackageJson(dir), undefined);
  });
  const empty = mkdtempSync(join(tmpdir(), "dpe-desc-none-"));
  try {
    assert.equal(descriptorVersionFromPackageJson(empty), undefined); // 无 package.json
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

/* ── ② 通道链:import → scan → package-version → 全失败 undefined ── */
test("resolver: import channel wins and reads the real constant (v2 host fixture)", async () => {
  await withFixtureAsync({ descriptorText: "export const SUBAGENT_DESCRIPTOR_VERSION = 2;\n", version: "0.1.1-rc.2" }, async (dir) => {
    const resolved = await resolveDescriptorVersion(dir, (url) => import(url));
    assert.deepEqual(resolved, { version: 2, channel: "import" });
  });
});

test("resolver: import failure falls to scan, scan failure falls to package semver", async () => {
  // descriptor.js 语法坏:import 抛 → 正则也扫不到(坏得彻底)→ package-version 通道接管
  await withFixtureAsync({ descriptorText: "export const SUBAGENT_DESCRIPTOR_VERSION = ???;\n", version: "0.1.1-rc.2" }, async (dir) => {
    const resolved = await resolveDescriptorVersion(dir, (url) => import(url));
    assert.equal(resolved?.channel, "package-version");
    assert.equal(resolved?.version, 2);
  });
  // 宿主改版挪走 descriptor.js:import 抛(文件不存在)→ 扫不到 → package-version
  await withFixtureAsync({ descriptorText: "", noDescriptorFile: true, version: "0.1.1-rc.1" }, async (dir) => {
    const resolved = await resolveDescriptorVersion(dir, (url) => import(url));
    assert.deepEqual(resolved, { version: 2, channel: "package-version" });
  });
});

test("resolver: import returning garbage constant is rejected; scan rescues the truth", async () => {
  // import 成功但常量非正整数(如 "3" 字符串/undefined)→ 落到扫描通道
  await withFixtureAsync({ descriptorText: "export const SUBAGENT_DESCRIPTOR_VERSION = 2;\n", version: "0.1.2-rc.1" }, async (dir) => {
    const resolved = await resolveDescriptorVersion(dir, async () => ({ SUBAGENT_DESCRIPTOR_VERSION: "2" }));
    assert.equal(resolved?.channel, "scan");
    assert.equal(resolved?.version, 2); // 文件事实优先于包名误导:package.json 说 0.1.2,但 descriptor.js 写 2
  });
});

test("resolver: all channels dead -> undefined (pin fallback decided by caller)", async () => {
  const empty = mkdtempSync(join(tmpdir(), "dpe-desc-none-"));
  try {
    const resolved = await resolveDescriptorVersion(empty, (url) => import(url));
    assert.equal(resolved, undefined);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

async function withFixtureAsync(options, run) {
  const dir = fixturePkg(options);
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── ③ 静态防回归 ── */
test("descriptor append stamps the resolved variable, never a hardcoded version", () => {
  assert.match(src, /version:\s*descriptorVersion,/);
  assert.doesNotMatch(src, /version:\s*2\s*,/); // 0.1.2 事故根因形态
  assert.doesNotMatch(src, /version:\s*3\s*,/); // 反向陷阱:钉死 3 会砸 0.1.1 用户
});

test("three real resolution channels wired in order; pin 3 only as last resort", () => {
  assert.match(src, /await resolveDescriptorVersion\(subagentPkgDir, \(url\) => import\(url\)\)/);
  assert.match(src, /await importModule\(descriptorEntry\)/); // 通道①
  assert.match(src, /scanDescriptorVersionFromFile\(pkgDir\)/); // 通道②(resolver 内)
  assert.match(src, /descriptorVersionFromPackageJson\(pkgDir\)/); // 通道③(resolver 内)
  assert.match(src, /descriptorVersion === undefined\) descriptorVersion = 3;/); // 全失败才 pin 最新契约
});

test("semver boundary comment records the empirical 0.1.2 cut", () => {
  assert.match(src, /0\.1\.0-rc\.8~0\.1\.1-rc\.2 = 2/);
});

/* ── ④ 本机真实宿主契约验证 ── */
// 测试端独立探测宿主 @deepseek-ai/dsh-subagent:候选根集中在 tests/host-locate.mjs,
// 与插件 findPackageDir 的策略同源(不截取该函数——其内部引用 import.meta,无法在
// new Function 中执行)。宿主桌面发行版目录名不固定,漏掉动态遍历会让这些断言静默 skip。
import { locateHostPkg } from "./host-locate.mjs";

const hostPkgDir = locateHostPkg("@deepseek-ai/dsh-subagent");
const hostSkip = hostPkgDir === undefined ? "host @deepseek-ai/dsh-subagent not locatable in this environment" : false;

test("host fold: plugin payload at the host's own version folds; ±1 versions fold to nothing (corrupt)", { skip: hostSkip }, async () => {
  const mod = await import(pathToFileURL(join(hostPkgDir, "lib", "types", "descriptor.js")).href);
  const CURRENT = mod.SUBAGENT_DESCRIPTOR_VERSION;
  const { foldSubagentDescriptor } = mod;
  // 本测试对 v2 宿主(0.1.1 用户机器)与 v3 宿主(0.1.2)都必须成立——契约对称性即兼容性证明
  assert.ok(Number.isInteger(CURRENT) && CURRENT >= 2, "host must export an integer version constant");

  const fold = (version) =>
    foldSubagentDescriptor([{ type: "subagent/descriptor", data: { version, mode: "one-shot", provider: "prompt-enhancer", label: "提示词强化" } }]);

  const folded = fold(CURRENT);
  assert.ok(folded !== undefined, "payload at the host's own version must fold to an identity");
  assert.equal(folded.mode, "one-shot");
  assert.equal(folded.provider, "prompt-enhancer");

  for (const stale of new Set([CURRENT - 1, CURRENT + 1])) {
    if (stale < 1 || stale === CURRENT) continue;
    assert.equal(fold(stale), undefined, `version ${stale} must NOT fold (this is the "会话记录损坏" classification)`);
  }
});

test("plugin resolver against the real host returns exactly the host constant", { skip: hostSkip }, async () => {
  const mod = await import(pathToFileURL(join(hostPkgDir, "lib", "types", "descriptor.js")).href);
  const CURRENT = mod.SUBAGENT_DESCRIPTOR_VERSION;
  const resolved = await resolveDescriptorVersion(hostPkgDir, (url) => import(url));
  assert.equal(resolved?.version, CURRENT, "plugin's stamp for THIS host must equal the host contract, whatever it is (2 on 0.1.1, 3 on 0.1.2+)");
  assert.equal(resolved?.channel, "import");
});
