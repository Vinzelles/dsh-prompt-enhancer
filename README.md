# @dsh-external/dsh-prompt-enhancer

DSH 提示词增强插件:在聊天输入框注入「强化 ✦」与「还原 ↺」两个图标按钮。

- **强化**:把当前草稿交给一个隔离子会话 agent(继承当前会话工具 + 只读工具限制 + 强化专用 persona),结合有界对话窗口(~8k token)与当前工作目录的仓库知识(agent 自行 glob/grep/read 定位 ≤5 个关联文件),重写为结构化、可执行的 agent 任务提示词并附「参考文件清单」,替换输入框草稿。**不自动发送、不进主对话历史**。
- **还原**:仅强化成功后显示;点击回退为强化前的原始提示词(单级)。用户手动编辑草稿或消息发送后入口自动消失。

## 行为基线(决策记录见 CONTEXT.md / docs/adr/)

- 保持输入语言;不增删用户真实需求;允许追加最少必要工作指令;软长度约束约为原文 2 倍。
- 无工作目录 / 检索零命中:静默降级为纯改写(省略参考文件清单)。
- 通道 B(子会话)超时 90s,失败自动降级通道 A(llm 直调,60s);失败/超时保留原文并 toast 提示,可重试。
- 隔离执行:子会话与主对话历史零污染(子会话 `origin: "subagent"`,dsh-session 强制校验)。
- 强化期间:输入卡片盖加载遮罩(防修改、显示取消按钮);取消会中止子代理(客户端 AbortController + 宿主连接断开联动)。
- 工作目录解析:活会话 header.cwd → 工作区注册表 path → 客户端上报 cwd 兜底;参考清单逐行校验存在性,臆造路径自动剔除。

## 用户设置(设置 → 插件 → 插件配置 → 提示词强化)

- **强化模型**:默认「跟随会话默认」(channel B 子代理继承父会话模型路由)。可选从当前 dsh 已配置模型列表选择 provider → model → 思考强度(列表来自 `GET /prompt-enhancer/models`,枚举 `ctx.llm.listProviders/listModels/resolveModelInfo`,含各模型支持的 efforts)。配置后 channel B 通过 `agentOptions.provider/model` + `agent/request` waterfall 注入思考强度;channel A 直接传参。
- **强化程度**三档:
  - `低`:仅措辞/结构润色,保持最接近原文篇幅;payload 明确禁止文件引用,host 端 `stripReferences` 兜底强制删除「## 参考文件」整节。
  - `中`(默认):标准优化,软长度 ≤2 倍原文,可附参考文件清单。
  - `高`:允许适度展开背景/步骤/验收(≤3 倍原文),参考文件照常。
- 配置存于 settings 文档的 `prompt-enhancer` 命名空间(schemastery schema:`model{provider,model,reasoningEffort?}` 可空 + `intensity` 枚举),文件热更新即时生效。

## 形态

- host(纯 JS ESM,`src/index.js`):`POST /prompt-enhancer` 端点 `{sessionId, draft}` → `{enhanced}`;`GET /prompt-enhancer/models` 模型目录;服务注入 `sessions/agents/llm/webServer/workspaceRegistry/sessionQuery`;设置命名空间经 `@deepseek-ai/dsh-settings` 的 `installSettingsSection` 注册。
  - **依赖加载**:插件 junction 指向源码目录(无 node_modules),静态裸 import 会被 cordis loader 从 realpath 位置解析而失败(Node 内部报 "job must be an instance of ModuleJob")——因此 `dsh-settings`/`schemastery` 用**运行时 `await import()` 绝对 file URL** 从 profile node_modules 加载(`profileModulesDir()` 探测)。
- client(纯 JS,`src/client/index.js`):`conversation.input.right` 官方槽注入按钮 + `settings.plugin.item` 注入设置卡片;依赖 `@deepseek-ai/dsh-client-runtime`、`-ui-slots`、`-ui-conversation`、`-client-locale`、`-ui-settings`(settingsScope)。
  - 设置卡片表单自实现(provider→model→effort 三级联动 + 强度三档 + 暂存/保存/放弃),不依赖 ui-settings-plugins 的 CardForm(避免跨插件导入)。

## 构建与注入

本插件为纯 JS(无 tsc/tsdown 依赖),构建即 src→lib 拷贝 + 特征校验:

```bash
bash scripts/build.sh          # host + client 拷贝
npm run build:client           # 与上等价(供 dev_build_plugin 第二步调用)
```

注入器环境内(`<插件目录>` 指本仓库在本机的绝对路径,调用时替换为实际路径):

```
dev_build_plugin {"dir": "<插件目录>"}
dev_inject_plugin {"dir": "<插件目录>"}
```

## 验证清单

1. 输入框右侧出现「强化」图标;草稿为空时禁用。
2. 点击强化 → 图标转 spinner → **输入卡片出现加载遮罩(含「取消」按钮,输入被锁定)** → 草稿被增强文本替换(手动发送)。
3. 强化成功后出现「还原」;点击还原草稿回退原文且还原消失。
4. 手动编辑草稿 / 发送消息后还原消失(严格触发)。
5. 强化期间点「取消」:遮罩消失、草稿保持原文、host 端子代理被中止。
6. 参考文件清单均为真实存在的文件(路径臆造会被自动剔除);无仓库/零命中时无该节(静默降级)。
7. 失败/超时 toast 提示,原文保留,可重试。
8. 设置 → 插件 → 插件配置出现「提示词强化」卡片:模型下拉含「跟随会话默认」+ 全部 provider/模型/思考强度;强度三档可切换;保存后写 settings 文档。
9. 强度设为「低」后强化:输出精简且**不含**「## 参考文件」节;设为「中/高」恢复带引用。
10. 配置专用模型(如 ac-gateway / ys-gpt/deepseek-v4-pro / high)后强化:diag log `enhance-start` 的 `model` 字段与宿主 `debug-stream.log` 的 `buildRequest done: provider=..., model=...` 显示该模型。

## 故障排查

- **诊断信标**:客户端在各执行阶段(factory/apply/slot 注册/组件挂载/槽崩溃)POST `/prompt-enhancer/diag`,host 落盘到 `~/.dsh/super-injector/prompt-enhancer-diag.log`。图标不显示时先看该日志:有 `slot-entry-error` = 组件渲染崩溃被槽渲染器静默退役(abdicate),错误详情在此。
- **host 端设置失效排查**:diag log 应有 `settings-source-set`(注入回调执行)与 `settings-change`(文档变更);`enhance-start` 的 `intensity`/`model` 字段反映实际生效配置。
- **已知陷阱**:React 组件渲染不能把原生 DOM 元素(如 `createElementNS` 产物)当 child,会触发 React error #31 并被 SlotErrorBoundary 静默吞掉——图标必须用 JSX/jsx-runtime 元素构建。
- **已知陷阱(schemastery)**:对象字段表达"可选"要用 `.default(null)` 而非 `.required(false)`——后者在对象字段上不生效,空文档会抛 "model.provider missing required value" 使整个设置注册静默失败。
- **host 端**:`GET /prompt-enhancer` 应返回 405,POST 空体应返回 400——证明 host 路由已注册;`GET /prompt-enhancer/models` 返回 `{groups, failures}`。
