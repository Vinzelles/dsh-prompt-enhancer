# dsh-prompt-enhancer

> 一句大白话丢进去，出来一份 agent 秒懂、自带参考文件清单的任务说明书——从此告别「我这个需求它怎么就是不懂」。

DSH(DeepSeek Harness)提示词增强插件。在聊天输入框右侧加两个按钮：

- **强化 ✦**：把当前草稿连同对话上下文交给同模型直调（不创建子会话、不检索仓库）——重写成结构清晰、约束明确、拿去就能用的任务提示词（末尾可附经过存在性校验的「参考文件」清单；直调没有文件工具，编造路径会被剔除），替换输入框草稿。**不自动发送、不进主对话历史**，改完你过目再发。
- **还原 ↺**：反悔了？一键退回强化前的原文。手动编辑过草稿或消息已发出时自动消失，不打扰。

## 安装

```sh
dsh plugin --profile web add github:Vinzelles/dsh-prompt-enhancer
```

或者直接将这句话发送给你的 DSH：

> 帮我安装 https://github.com/Vinzelles/dsh-prompt-enhancer 这个插件

装完重启 `dsh web`（或刷新页面），输入框右侧就能看到 ✦。

## 宿主兼容

| 宿主版本 | 状态 |
| --- | --- |
| **0.2.0+**（含 0.2.1-rc.2，当前基线） | ✅ 完整支持 |
| ≤ 0.1.3 | ❌ 不支持——`peerDependencies` 已声明 `^0.2.0-rc.2`，宿主在加载前即按版本不满足拒绝；请升级宿主，或留用插件 0.1.3 |

0.2.x 相对 0.1.x 有三处承重变化，本插件均已按新契约重写：

- **设置面板**：`installSettingsSection` / `settingsNamespace` / `ctx.settings.installSection` 在 0.2.x 全部移除，官方通道改为「插件导出 `Config` schema（可调字段标 `.volatile()`）+ profile patch 落配置」。面板表单由宿主 `dsh-settings` 从 `entry.fiber.runtime.Config` 反投影生成，命名空间即 profile patch 的 entry id（本插件为 `prompt-enhancer`）；未标 volatile 的字段不会出现在面板里。插件把四个可调项（`model` / `intensity` / `outputEnglish` / `nextSuggestion`）声明为 volatile 字段，`apply(ctx, config)` 的第二参即校验后的配置；volatile 值运行时以引用对象（`{get()}`）下发，插件逐键取值，改设置即时生效、无需重启。
- **客户端设置槽位**：`settings.plugin.item` 槽位与 `settingsScope` 客户端服务在 0.2.x 均已移除。设置卡片改走 `ctx.configForms.get("prompt-enhancer")`（`ConfigFormController`：`getSnapshot` / `subscribe` / `set` / `unset` / `mutate`，写操作返回 `Promise<boolean>`——宿主拒绝时是 `false` 而非抛异常）+ `settings.plugins.tab` 槽位（注册项用 `id` + `label`，不再是 `key`）。输入框按钮所在槽位 `conversation.input.right` 未变。
- **宿主依赖树定位**：裸 `@deepseek-ai/*` import 的解析规则改为「插件 `package.json` 的 `peerDependencies` 必须声明该包名」；插件按「profile node_modules → `DSH_HOME` 上溯 → 包自身上溯 → 宿主 bin（`process.argv[1]`）上溯 → 扫 `%APPDATA%` 下所有含 `dependencies/dsh/node_modules` 的发行版目录 → `.pnpm` store」逐级探测宿主包目录，桌面端目录名（如 `dsh-tauri`）不再写死。

线上强化走模型直调，不再创建子会话，因此也不会再出现「会话记录损坏」的强化子代理行。仓库里仍保留隔离子会话实现与身份契约解析（`subagent/descriptor` 版本随宿主 dsh-subagent 动态解析、落点必须是 Agent 实例），供既有单测切片，运行路径不再调用。
## 强化程度与模型

设置 → 内置插件 → Tab「提示词强化」：

| 强度 | 效果 |
| --- | --- |
| 低 | 只做措辞与结构润色，篇幅最接近原文，不带任何文件引用 |
| 中（默认） | 标准优化、输出紧凑（约 ≤1.5 倍原文），参考文件只列路径 |
| 高 | 充分展开背景/步骤/验收（≤3 倍原文），参考文件带说明 |

还可以给强化单独指定模型（provider → model → 思考强度三级联动），不配置则跟随会话默认模型；配置即时生效，无需重启。
建议设置轻量快速的模型，避免强化消耗过多token或是耗费时间过长。

另有「**转换英文**」开关（默认关）：开启后无论输入什么语言，强化结果都会自动输出为英文提示词（参考文件节标题变为 `## Reference Files`，需要兜底回填的技能引用节为 `## Skill References`）；skill 引用记号、文件路径与专有名词保持原样不翻译，参考文件的存在性校验照常生效。关闭则保持默认行为（输出跟随输入语言）。

「**下一轮建议**」也默认关闭。打开后，一轮回复结束且输入框为空、聚焦时，会用灰字给出一条可继续发送的草稿；按 Tab 或点右侧 Tab 只填入草稿，不自动发送。开始打字即隐藏，删空后同一条建议再出现，不重复调用模型；Esc 则藏到下一轮结束。它只走模型直调，不建子会话、不检索仓库。

## 值得信任的地方

- **零污染**：强化只走模型直调，主对话历史干干净净；失败保留原文并 toast 提示，可重试。
- **不瞎编路径**：参考文件清单逐行校验存在性，臆造路径自动剔除；没有仓库或检索零命中时静默省略该节。
- **引用不丢**：草稿里的 skill 引用记号（`/tdd`、`/code-review` 这类）强化后原样保留——模型改写意外丢失时自动以「## 技能引用」节补回，发送后技能照常生效。
- **可中止**：强化期间输入卡片盖上加载遮罩、锁定编辑；点「取消」立即中止直调请求，草稿保持原文。

## 故障排查

图标不显示或行为异常时，先看诊断日志 `~/.dsh/super-injector/prompt-enhancer-diag.log`——各执行阶段的信标都落在这里（`slot-entry-error` = 按钮组件渲染崩溃被槽渲染器静默退役，错误详情就在日志里）。快速自检：`GET /prompt-enhancer` 应返回 405、空体 `POST /prompt-enhancer` 应返回 400，说明 host 路由已注册。

## 开发

纯 JS（无 tsc/tsdown 依赖），构建即 src → lib 拷贝加特征校验：

```bash
bash scripts/build.sh
```

注入器环境内（`<插件目录>` 指本仓库在本机的绝对路径，调用时替换为实际路径）：

```
dev_build_plugin {"dir": "<插件目录>"}
dev_inject_plugin {"dir": "<插件目录>"}
```

领域术语与行为契约见 [CONTEXT.md](CONTEXT.md)，执行通道决策见 [docs/adr/](docs/adr/)，10 项功能验收基线见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

## License

MIT
