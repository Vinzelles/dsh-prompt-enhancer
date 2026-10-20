# ADR-0003:客户端快照 store 引擎运行时解析 — 双代宿主(0.1.1/0.1.2+)兼容

- 状态:已接受
- 日期:2026-09-10

## 背景

插件客户端(输入框「强化/还原」按钮与设置卡片)需要宿主的快照 store 引擎 `createSnapshotStore`,得到 `{getSnapshot, subscribe, update, set}` 四件套。它通过槽位注册的 `hooks: { promptEnhancer: store }` 交给宿主;宿主把它当 observable 源用 uSES 绑成 `usePromptEnhancer(selector)`(ui-slots 契约 `HooksSources = Record<string, HostObservable>`——注释明示「bare observable sources(getSnapshot + subscribe pairs)」)。

宿主升级搬走了这个引擎(经本机内核逐一实测):

| 宿主代际 | 引擎所在 | 客户端可见拼写 |
| --- | --- | --- |
| 0.1.1(-rc.2) | `@deepseek-ai/dsh-client-runtime` 为真实预载模块 | `@deepseek-ai/dsh-client-runtime/client` |
| 0.1.2-rc.1 / 0.1.3-alpha.1 | 启动壳 `staticModules` 预置的平台种子 | `@deepseek-ai/dsh-client-store` |

两代拼写没有交集(0.1.2+ 的种子表为 react、react/jsx-runtime、react-dom、react-dom/client、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`)。

事故:插件把 `const { createSnapshotStore } = require("@deepseek-ai/dsh-client-runtime/client")` 写在懒 CJS 工厂顶部——这是一次**静态解析**。0.1.2 的模块表答不上来即抛 `client-modules: require(...) missed the module table`,且失败粒度是整条 loader entry 的导入:启动页直接 `Failed to load plugins`,按钮与设置卡片全部不加载(不是局部降级)。本机曾靠给内核 `dsh-client-modules/lib/client.js` 手工补一个同名 compat 种子撑着,而内核一重装/升级(profile 的 node_modules 是指向内核的 junction)补丁即失效、故障立刻复发——**宿主侧补丁不能作为插件的兼容手段**。

## 决策

引擎**永不静态解析**,在工厂作用域内运行时逐条查表,三级兜底:

1. `@deepseek-ai/dsh-client-store`——0.1.2+ 平台种子,新平台优先(宿主若另装同名 compat 别名也不抢先)。
2. `@deepseek-ai/dsh-client-runtime/client`——0.1.1 预载模块。
3. 两条都查不到(未来宿主改种子名):退回插件内置等价实现 `fallbackSnapshotStore`,同 `{getSnapshot, subscribe, update, set}` 契约,插件自身状态不依赖宿主内部,仅 `console.warn` 留痕。

查表经工厂参数 `require(变量)`(不得出现字面量,否则退回静态解析),命中判据 `typeof engine?.createSnapshotStore === "function"`(导出残缺继续下一条),全程 try/catch。`tests/client-store-resolution.test.mjs` 锁定:两代命中路径、导出残缺不误用、双缺失退回本地、observable 契约行为、源码无字面量 require、`lib/client.js` 与源码同源。

## 后果

- 正面:0.1.1 与 0.1.2/0.1.3 用户同时可用;宿主再搬引擎时第 3 级兜底保证按钮不断供,只在 console 留痕;插件彻底不依赖宿主侧补丁(修复后内核已恢复原版并实测通过)。
- 代价:多约 20 行兜底实现,且兜底实例与宿主引擎非同一实例——但槽位 hooks 契约只消费 getSnapshot/subscribe,不涉宿主内部语义(本插件的 `update` 走插件自有状态)。
- 约束:兜底是为「不可解析」而设,不是默认路径。若某代宿主上警告频发,应视为宿主契约变更信号并更新本 ADR,而不是删掉前两级。

## 替代方案(否决)

- 继续静态 require 单一拼写:每次宿主搬包都要发新版;内核侧手工补丁丢失即整插件不加载——正是本次事故。
- 只查平台种子 `@deepseek-ai/dsh-client-store`:0.1.1 上不存在,老宿主整插件失败。
- 只查老拼写、靠宿主 compat 种子:依赖非上游的宿主侧补丁(已验证会被内核更新冲掉)。
- 完全手写 store、不查平台:宿主将来若给快照 store 追加持久化/批处理(uSES 通知合并、`flush: "raf"`)语义会静默失配;优先用宿主引擎,兜底才自建。
