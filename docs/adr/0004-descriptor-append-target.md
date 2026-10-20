# ADR-0004:子代理身份事件的「落点」契约 — 必须写在 Agent 实例上,不是 ctx

- 状态:已接受
- 日期:2026-09-12

## 背景

ADR-0002 解决了 descriptor 的**版本**契约(值必须等于宿主 `SUBAGENT_DESCRIPTOR_VERSION`),但插件每次强化创建的子会话**仍然**全部显示「会话记录损坏」。2026-09-12 对真实会话日志取证(`~/.dsh/sessions/<cwd>/session-<childId>/session.v3.jsonl.zstd`):

```
seq 0  session/end-seed
seq 1  permission/preset        ← setup 窗口内的事件确实落盘了
seq 2  sandbox/mode
seq 3  approval/policy
seq 4  subagent/model-selection-policy
seq 5  agent/inbox/spliced
seq 6  turn/start
```

**整条日志没有任何 `subagent/descriptor`**。即:版本解析是对的(diag `descriptor-version-resolved {"version":3,"channel":"import"}`),`foldSubagentDescriptor` 收到的却是空数组 → 身份为 `null` → `list-children` 冷读路径(`resolveColdIdentity`)返回 `{kind:"diagnostic", reason:"corrupt"}` → UI「会话记录损坏」。

**事发时间窗(全量日志普查,2026-09-12)**:解码 `~/.dsh/sessions` 下全部 276 份会话日志,含 `prompt-enhancer` descriptor 的强化子会话共 **69 个,时间跨度 2026-08-21T04:45Z → 2026-09-10T08:46Z**;缺身份的子会话只有 3 个——`session-56987c9f`(2026-09-11T07:18Z,**首个失败**)与本次取证的两个。09-11 正是 profile `node_modules` 迁移窗口(`dependencies/dsh.before-migration-20260911`)。也就是说:**这不是「从来没有写过」,而是「曾经写了三周,09-11 之后归零」**。

由此得到两条独立结论:

1. **提交里的落点写法在任何一代宿主上都不可能工作。** 原实现:
   ```js
   const setup = (childCtx) => {
     childCtx.agent.session.append("subagent/descriptor", { … });   // TypeError!
   };
   ```
   宿主 ctx 上注册的服务名是 **`agents`**(`AgentRegistry extends Service` → `super(ctx, "agents")`),不存在 `agent` 属性;`dsh-scope` 的 `createScope` 在两代宿主里逐字相同,也不会注入 `agent`。该行为自 4c2457a(2026-08-27)起就在提交历史里。
2. **09-10 之前线上跑的不是这份提交产物。** `lib/` 被 gitignore,profile 里链接的 `~/.dsh/local-plugins/dsh-prompt-enhancer` 是**独立文件树**(非硬链接),所以那段窗口里生效的是手工同步/手改过的变体(其写法必然能用——例如走 `agent/pre-step` 载荷)。09-11 迁移把产物刷回提交形态,潜伏的缺陷才暴露。旧产物已不在磁盘上,**无法进一步区分「重新部署了坏产物」与「宿主升级改了 ctx 面」,但结论不受影响:提交里的写法两代都不成立。**

各代宿主的真实落点(两代都已核对):

| 宿主代 | setup 调用形态 | 可用的 Agent 来源 |
| --- | --- | --- |
| 0.1.2-rc.1(旧) | `setup?.(prepared.agent.ctx)` —— **只有 ctx,没有第二参** | 只有 `agent/pre-step` 载荷里的 `agent` |
| 0.1.5-rc.2(今) | `setup?.(prepared.agent.ctx, prepared.agent)` | setup 第二参,或 `agent/pre-step` 载荷 |

官方驱动 `@deepseek-ai/dsh-subagent-in-process-driver` 的写法正是两者都用:

```js
const setup = (childCtx, child) => { appendDelegatedPolicyOverrides(child.session, inherited); … };
childCtx.on("agent/pre-step", async ({ agent }, next) => { … agent.session.append("subagent/descriptor", descriptor); });
```

那行 `TypeError` 被 try/catch 吞成一条 `logger.warn`,既不进 diag log,也不影响强化结果——于是插件「工作正常」,损坏却每次必现。

附带教训:ADR-0002 的回归测试直接对 `foldSubagentDescriptor([{payload}])` 断言,验证了**载荷**却没验证**载荷有没有进日志**;VERIFICATION 第 17 项据此声明「不出现会话记录损坏」,属于验证了错误的接缝。

## 决策

descriptor 的追加走 `installDescriptorAppend(childCtx, child, payload)`,双通道、`appended` 标志保证恰好一条:

1. **setup 第二参(首选)**:`append(child)` → `child.session.append("subagent/descriptor", payload)`。创建窗口内立即落盘,连「未被 step 就取消」的子会话也带身份。
2. **agent/pre-step 兜底**(拿不到第二参时——**旧宿主代根本不传**,见上表):与官方驱动同形,首个 `decision.kind === "enter"` 的步里用事件载荷的 `agent` 追加;waterfall 决策原样透传。

并强制**可观测**,不允许再静默:

- `enhance-child-ready` / `enhance-child-descriptor-final` 记录 `descriptorAppended` / `descriptorArmed` / `descriptorPath` 与真实日志里的 descriptor 条数;
- 两个落点都不可用(`armed=false`)或日志里 descriptor 条数为 0 时,落 `enhance-child-descriptor-unarmed` / `descriptorEvents: 0` 诊断 + `logger.warn`——损坏可事前从 diag log 取证,不必等 UI 报损坏。

## 后果

- 正面:强化子会话在子代理目录里显示为正常的 one-shot 子代理(`提示词强化` · 单次 · 已结束),不再出现「会话记录损坏」;子会话仍是隔离子会话,不进主对话历史,也不污染顶层会话列表(仍带 `origin: "subagent"` + `parentSession`)。
- 正面:落点错误这类「静默 catch 掉的身份缺失」从此有 diag 信标,测试也锚住行为(不再只锚载荷形状)。
- **正面(双通道不是对称的,而是必需的)**:旧宿主代 `setup?.(prepared.agent.ctx)` **根本不传第二参**,所以 `agent/pre-step` 通道在 0.1.1/0.1.2 上才是主通道;只写 setup 第二参的实现在旧宿主上会再次丢身份。两通道都保留是双代兼容的一部分,不是冗余。
- 代价:两个落点 + 两个访问器;`armed/appended` 语义读日志时要区分(`armed=false` 才是确定性损坏;`armed=true, appended=false` 只可能发生在子会话一个 step 都没跑时)。
- 残留风险(接受):版本解析三级通道全失败时会 pin `3`——将来宿主换成别的常量又会静默变 corrupt。此时落盘 `descriptor-version-resolved {channel:"pin-latest"}` 并 `console.warn`,可事后取证;彻底消除需要宿主提供稳定的版本发现接口,超出插件能力。
- 约束:子会话必须保持 `origin: "subagent"`;若将来改掉,子代理目录会**不再列出**这些子会话(另一种「不显示」的解法,见下)。
- 工程教训(过程记录):`lib/` 被 gitignore、部署目录是独立文件树,导致「提交形态」与「线上形态」曾长期不一致——缺陷因此在提交里潜伏 15 天才被发现。交付后仍需保证「构建产物 = 提交源码」,改完 `src/` 必须重建 `lib/` 并同步部署目录(本次已同步并逐一比对 SHA256)。

## 替代方案(否决)

- **不显示在子代理会话中**(用户给出的另一选项):去掉 `meta.origin = "subagent"` 即可让 `list-children` 过滤掉它,但**会话本身不会消失**——一个子会话一份日志照样落盘,而会话列表本就按 `parentSessionId` 把它嵌在父会话下(`dsh-api-session-controller` 的 `flattenLineage`:凡父在列表内即 `depth + 1` 缩进),所以「不显示」只删掉子代理目录里那一行,等于把「可点开查看增强过程、明确标注为 one-shot 子代理」的入口换成一条没有来源标注的嵌套条目。用户真实痛点是「损坏」而不是「存在」,故修根因。
- **改用官方 seam 创建子代理**(`SubagentRuntime`/`dsh-tool-subagent` 的 driver):官方 driver 只在首步 pre-step 追加 descriptor,创建窗口内被取消/无文本的子会话没有身份,恰好回到 corrupt;而且会把插件绑死在特定宿主代际的 subagent seam 上,与 ADR-0002 的双代兼容定位冲突。
- **把 descriptor 追加挪进 `agent/request` / `agent/pre-step` 单一通道**:首步之前的取消路径(用户点「取消」、超时)就丢身份;官方同形的兜底只作为第二通道保留。
- **继续只 warn**:正是本次事故的形态——失败不可观测,回归无法从日志发现。
