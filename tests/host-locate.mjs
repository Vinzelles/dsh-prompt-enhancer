// 测试端宿主包探测(与 src/index.js 的 findPackageDir 候选根同源)。
// 为什么不直接截取 findPackageDir:它引用 import.meta,无法在 new Function 中执行。
// 这里必须跟着实现的探测策略一起演进——宿主桌面发行版目录名不固定(dsh-tauri /
// io.github.hairyf.deepseek-harness-desktop / ...),只靠 DSH_HOME 上溯会全部落空,
// 于是真实宿主契约测试会被静默 skip(2026-10-20 在 0.2.1-rc.2 实测到)。
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** 收集 node_modules 候选根(顺序即优先级,去重)。 */
function candidateRoots() {
  const seen = new Set();
  const roots = [];
  const add = (nm) => {
    if (!nm || seen.has(nm)) return;
    seen.add(nm);
    roots.push(nm);
  };
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  for (const name of ["web", "default"]) add(join(home, "profiles", name, "node_modules"));
  add(join(home, "node_modules"));
  add(join(home, "dependencies", "dsh", "node_modules"));
  for (let dir = home; ; ) {
    add(join(dir, "dependencies", "dsh", "node_modules"));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // 宿主进程自身的安装位置(最可靠的运行时事实):测试由 node 直接启动时 argv[1]
  // 是测试文件本身,探测会自然落空,但当测试被宿主/工具链拉起时就命中。
  const argvEntry = process.argv?.[1];
  if (typeof argvEntry === "string" && argvEntry !== "") {
    for (let dir = dirname(argvEntry); ; ) {
      add(join(dir, "node_modules"));
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  if (process.platform === "win32") {
    const roaming = join(homedir(), "AppData", "Roaming");
    try {
      for (const entry of readdirSync(roaming)) {
        add(join(roaming, entry, "dependencies", "dsh", "node_modules"));
      }
    } catch { /* AppData 不可读:跳过 */ }
    add(join(roaming, "io.github.hairyf.deepseek-harness-desktop", "dependencies", "dsh", "node_modules"));
  }
  return roots;
}

/**
 * 定位宿主依赖树里的 @deepseek-ai 包目录。
 * @param pkg - 包名(如 "@deepseek-ai/dsh-subagent")。
 * @returns 含 package.json 的包目录绝对路径;定位不到返回 undefined。
 */
export function locateHostPkg(pkg) {
  const enc = pkg.replace("/", "+");
  for (const nm of candidateRoots()) {
    const direct = join(nm, pkg);
    if (existsSync(join(direct, "package.json"))) return direct;
    const store = join(nm, ".pnpm");
    if (!existsSync(store)) continue;
    let storeDirs = [];
    try {
      storeDirs = readdirSync(store);
    } catch {
      continue;
    }
    for (const d of storeDirs) {
      if (!d.startsWith(enc + "@")) continue;
      const p = join(store, d, "node_modules", pkg);
      if (existsSync(join(p, "package.json"))) return p;
    }
  }
  return undefined;
}
