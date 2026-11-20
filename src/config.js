/* ═══════════════ 插件配置契约(dsh 0.2.x 官方形态) ═══════════════
 * 0.2.x 的设置面板不再有 installSection/installSettingsSection 注册通道:
 * 宿主 settings 服务改为从 `entry.fiber.runtime.Config` 读取插件自己导出的
 * schemastery schema(dsh-settings/lib/index.js `schema(entry)`),再用
 * volatileForm() 投影出表单字段。因此:
 *   ① 本文件必须导出真实 schema 对象——cordis 在 fiber 建立时同步调用
 *      runtime.Config["~standard"].validate(config),无法延后到 apply;
 *   ② 每个要出现在设置面板里的字段都必须标 .volatile()——dsh-settings 的
 *      volatileForm() 只投影带 volatile meta 的字段,没标的字段绝不渲染;
 *   ③ volatile 字段在 apply(ctx, config) 收到的 config 里不是普通值,而是
 *      cosmokit 的引用对象 { get(), [Symbol.for("cosmokit.volatile.write")] };
 *      用户改设置时宿主只写这个引用、不重启插件 → 每次请求 ref.get() 即时生效。
 *
 * 解析方式:宿主 dsh-app-boot 的 routeLinked 会把 linked(vendor/软链)插件里的
 * 裸 `@deepseek-ai/*` specifier 重路由到宿主安装树,前提是该包名出现在插件
 * package.json 的 peerDependencies 里(与官方 dsh-tool-present、dsh-tavily 同构)。
 * 这里用「顶层 await 动态 import + 失败降级」而不是静态 import:能解析时导出
 * 真实 Config(设置面板可用),解析不到时导出 undefined——cordis 的
 * resolveConfig 见到 `!runtime.Config` 会跳过校验,插件仍能加载(只是没有设置卡片),
 * 不会因为一个可选依赖把整个插件打成加载失败。 */

let Schema = null;
try {
  const mod = await import("@deepseek-ai/schemastery");
  const candidate = mod?.default ?? mod;
  if (typeof candidate === "function" || (candidate !== null && typeof candidate === "object")) {
    Schema = candidate;
  }
} catch { /* schemastery 不可解析:Config 退化为 undefined,插件仍可加载 */ }

/** 需要从 config 里取出的键(与下面 schema 字段一一对应)。 */
export const CONFIG_KEYS = ["model", "intensity", "outputEnglish", "nextSuggestion"];

/** 设置面板字段顺序即此处声明顺序。
 *  model 用 .default(null) 而非 .required(false):后者在对象字段上不生效,
 *  空文档会抛 "model.provider missing required value"。 */
export const Config =
  Schema === null
    ? undefined
    : Schema.object({
        // 强化专用模型。不配置(默认 null)= 跟随当前会话模型。
        model: Schema.object({
          provider: Schema.string().min(1).required(),
          model: Schema.string().min(1).required(),
          reasoningEffort: Schema.string(),
        }).default(null).volatile(),
        // 强化程度:控制输出长度与是否保留文件引用。
        intensity: Schema.union(["low", "medium", "high"]).default("medium").volatile(),
        // 转换英文开关:开启后无论输入什么语言,强化结果都输出为英文提示词。
        outputEnglish: Schema.boolean().default(false).volatile(),
        // 下一轮建议:一轮结束后在空输入框给出灰字草稿。默认关,避免额外模型调用。
        nextSuggestion: Schema.boolean().default(false).volatile(),
      });

/** 把 apply(ctx, config) 收到的配置折叠成普通值:
 *  - volatile 引用对象 → ref.get();
 *  - 已经是普通值(旧宿主、单测注入、或宿主某代不包 volatile) → 直接用;
 *  - 缺失 → 跳过,交给调用方按默认值处理。
 *  深拷贝,避免调用方把宿主内部状态写坏。 */
export function readEnhancerConfig(config) {
  const value = {};
  if (config === null || typeof config !== "object") return value;
  for (const key of CONFIG_KEYS) {
    const ref = Reflect.get(config, key);
    if (ref === undefined) continue;
    if (ref !== null && typeof ref === "object" && typeof ref.get === "function") {
      value[key] = structuredClone(ref.get());
    } else {
      value[key] = structuredClone(ref);
    }
  }
  return value;
}
