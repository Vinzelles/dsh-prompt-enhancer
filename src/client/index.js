window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-prompt-enhancer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const { jsx } = require("react/jsx-runtime");
    const { useState, useRef, useEffect, useSyncExternalStore } = require("react");
    const { createPortal } = require("react-dom");
    const CODEX_PREDICTION_MODELS = Object.freeze(["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"]);
    function codexPredictionOwns({ provider, model }) {
      return provider === "openai-codex" && CODEX_PREDICTION_MODELS.includes(model);
    }
    function suggestionConsumed(suggestion, draft) {
      return suggestion !== "" && typeof draft === "string" && draft.trim() !== "" && draft !== suggestion;
    }
    function suggestionView(input) {
      const current = input.loadedKey === input.turnKey;
      const quiet = input.enabled === true && input.busy !== true && input.empty === true && input.attachmentCount === 0 && (input.composerPhase === "plain" || input.composerPhase === undefined) && input.turnKey !== "" && input.codexOwned !== true;
      if (!quiet || input.dismissed === true || input.consumed === true) return { request: false, showText: false, placeholder: "normal" };
      if (current && input.phase === "ready" && input.suggestion !== "") return { request: false, showText: true, placeholder: "hidden" };
      if (input.phase === "failed" || (input.phase === "ready" && input.suggestion === "")) return { request: false, showText: false, placeholder: "normal" };
      return { request: true, showText: false, placeholder: "loading" };
    }
    /** 请求副作用该做什么:只有确实装过、且属于别的回合的旧结果才清。
     *  注意 loadedKey 为空只表示本回合还没装载过,必须放行请求,否则会永远停在加载态。 */
    function suggestionSync({ turnKey, loadedKey, request }) {
      if (turnKey === "") return loadedKey === "" ? "hold" : "clear";
      if (loadedKey === "") return request === true ? "request" : "hold";
      if (loadedKey !== turnKey) return "clear";
      return request === true ? "request" : "hold";
    }
    /** 把宿主 modelCatalog RemoteResult 或本插件 HTTP JSON 收成 groups 数组。 */
    function catalogGroupsFromRemote(response) {
      if (response === null || typeof response !== "object") throw new Error("bad payload");
      if (Object.hasOwn(response, "ok")) {
        if (response.ok !== true) {
          const message = response.error && typeof response.error === "object" ? response.error.message : undefined;
          throw new Error(typeof message === "string" && message !== "" ? message : "modelCatalog failed");
        }
        return catalogGroupsFromRemote(response.value);
      }
      if (!Array.isArray(response.groups)) throw new Error("bad payload");
      return response.groups;
    }
    /* ═══════════════ 平台快照 store 引擎(0.1.1 / 0.1.2+ 双版解析) ═══════════════ */
    // 0.1.2 删除了 @deepseek-ai/dsh-client-runtime 包,改为在启动壳里预置
    // @deepseek-ai/dsh-client-store 平台种子;两版拼写没有交集,只能在运行时逐条查表。
    // 工厂顶部的静态 require 一旦落空,client-modules 抛「require(...) missed the module
    // table」并中止整条 loader entry——插件整体不加载,不是局部降级。
    function fallbackSnapshotStore(init) {
      let state = init;
      const listeners = new Set();
      return {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        update: (mutator) => {
          const draft = Object.create(Object.getPrototypeOf(state), Object.getOwnPropertyDescriptors(state));
          mutator(draft);
          state = draft;
          for (const listener of [...listeners]) listener(state);
        },
        set: (next) => {
          state = next;
          for (const listener of [...listeners]) listener(state);
        },
      };
    }
    function resolveCreateSnapshotStore() {
      const candidates = ["@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-runtime/client"];
      const tried = [];
      for (const specifier of candidates) {
        try {
          const engine = require(specifier);
          if (typeof engine?.createSnapshotStore === "function") return engine.createSnapshotStore;
          tried.push(specifier + ":无 createSnapshotStore 导出");
        } catch (error) {
          tried.push(specifier + ":" + (error?.message ?? String(error)));
        }
      }
      // 两个拼写都查不到(未来内核改种子名):退回本地等价实现——hooks 契约只要求
      // getSnapshot/subscribe 一对,插件自身状态不依赖平台内部。
      console.warn("[prompt-enhancer] 平台快照 store 引擎缺失,已退回本地实现", tried);
      return fallbackSnapshotStore;
    }
    const createSnapshotStore = resolveCreateSnapshotStore();

    /* ═══════════════ 诊断信标(轻量监控,落盘 ~/.dsh/super-injector/prompt-enhancer-diag.log) ═══════════════ */
    const DIAG_URL = "/prompt-enhancer/diag";
    function beacon(stage, detail) {
      try {
        void fetch(DIAG_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stage, detail: detail ?? null }),
        }).catch(() => {});
      } catch { /* 诊断失败静默 */ }
    }
    if (typeof window !== "undefined") {
      try {
        window.addEventListener("error", (event) => {
          beacon("window-error", { message: String(event?.error?.message ?? event?.message ?? "unknown") });
        });
        window.addEventListener("unhandledrejection", (event) => {
          beacon("unhandledrejection", { message: String(event?.reason?.message ?? event?.reason ?? "unknown") });
        });
      } catch { /* 监听注册失败静默 */ }
    }
    beacon("factory-executed");

    /* ═══════════════ 常量 ═══════════════ */
    const NS = "prompt-enhancer";
    const ENDPOINT = "/prompt-enhancer";
    const CLIENT_TIMEOUT_MS = 70000; // 通道 A 60s + 余量

    /* ═══════════════ 图标(React 元素;原生 DOM 元素会触发 React error #31) ═══════════════ */
    // 强化图标:复用官方 dsh-client-ui-primitives 的 IconSparkle16 三星 sparkle 路径
    // (主星 + 两颗小星,Q 曲线内凹,饱满清晰;替代原直线四角星——太细像加号)。
    const SPARKLE_PATHS = [
      "M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z",
      "M11.9 1Q12.2 3.7 14.9 4Q12.2 4.3 11.9 7Q11.6 4.3 8.9 4Q11.6 3.7 11.9 1Z",
      "M12.5 9.4Q12.7 11.4 14.7 11.6Q12.7 11.8 12.5 13.8Q12.3 11.8 10.3 11.6Q12.3 11.4 12.5 9.4Z",
    ];
    const UNDO_PATH =
      "M4.8 4.9 C6 3.6 7.8 3 10 3 C12.9 3 15.2 5.3 15.2 8 C15.2 10.7 12.9 13 10 13 C8.7 13 7.5 12.6 6.5 11.9 L6.5 10.4 C7.5 11.2 8.7 11.6 10 11.6 C12 11.6 13.7 9.9 13.7 8 C13.7 6.1 12 4.4 10 4.4 C8.7 4.4 7.5 5.1 6.8 6.1 L8.2 7.5 L4.6 7.5 L4.6 3.9 Z";

    function iconSvg(paths) {
      const list = Array.isArray(paths) ? paths : [paths];
      return jsx("svg", {
        width: 16,
        height: 16,
        viewBox: "0 0 16 16",
        fill: "none",
        "aria-hidden": true,
        children: list.map((d) => jsx("path", { d, fill: "currentColor" })),
      });
    }

    /* ═══════════════ 样式(主题变量对齐官方 composer) ═══════════════ */
    const CSS_TEXT = [
      // 注意:.dpe_root 刻意不建定位上下文(position 保持 static)——否则 absolute 遮罩的包含块会锁死在按钮组上。
      // DOM 链中唯一 positioned 祖先是输入卡片 .card{position:relative}(槽锚点 display:contents 不建盒,.row/.trailing 均 static),
      // 因此 .dpe_mask 的 absolute 直接相对整张输入卡定位。
      ".dpe_root{box-sizing:border-box;align-items:center;gap:2px;display:inline-flex}",
      ".dpe_iconButton{box-sizing:border-box;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:50%;justify-content:center;align-items:center;width:28px;height:28px;padding:0;display:inline-flex}",
      ".dpe_iconButton:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".dpe_iconButton:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}",
      ".dpe_iconButton:disabled{cursor:default;opacity:.4}",
      ".dpe_spinner{box-sizing:border-box;width:14px;height:14px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:dpe_spin .8s linear infinite}",
      "@keyframes dpe_spin{to{transform:rotate(360deg)}}",
      // 加载遮罩:包含块 = 输入卡片(.card,position:relative),inset:-1px 覆盖整卡(含 1px 边框),圆角对齐卡片 22px
      ".dpe_mask{position:absolute;inset:-1px;z-index:40;border-radius:22px;background:var(--dsw-alias-bg-mask,#00000073);backdrop-filter:blur(2px);align-items:center;justify-content:center;gap:10px;display:flex}",
      ".dpe_maskLabel{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
      ".dpe_cancel{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:14px;height:28px;padding:0 12px;font-size:12px;line-height:18px}",
      ".dpe_cancel:hover{background:var(--dsw-alias-bg-module-hover)}",
      ".dpe_toast{position:absolute;right:0;bottom:calc(100% + 8px);z-index:30;box-sizing:border-box;max-width:340px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:6px 10px;font-size:12px;line-height:18px;white-space:pre-wrap;box-shadow:var(--dsw-shadow-lv2)}",
      // 设置卡片(设置 → 插件 → 插件配置)
      ".dpe_card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:12px;padding:14px 16px;gap:10px;display:flex;flex-direction:column}",
      ".dpe_cardHead{display:flex;flex-direction:column;gap:2px}",
      ".dpe_cardTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}",
      ".dpe_cardDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
      ".dpe_field{display:flex;flex-direction:column;gap:4px}",
      ".dpe_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
      ".dpe_select{box-sizing:border-box;width:100%;height:32px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font:inherit;font-size:13px;padding:0 8px;outline:none}",
      ".dpe_select:focus-visible{border-color:var(--dsw-alias-state-business-primary)}",
      ".dpe_select:disabled{opacity:.5;cursor:not-allowed}",
      ".dpe_radioRow{display:flex;gap:8px;flex-wrap:wrap}",
      ".dpe_radio{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);cursor:pointer;border-radius:8px;padding:6px 10px;font-size:12px;line-height:16px;display:flex;flex-direction:column;gap:1px;align-items:flex-start;text-align:left}",
      ".dpe_radio small{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:14px}",
      ".dpe_radio[data-on=true]{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}",
      ".dpe_radio:disabled{opacity:.5;cursor:not-allowed}",
      // 转换英文开关(设置卡片内):iOS 风格小开关
      ".dpe_toggleRow{display:flex;align-items:center;justify-content:space-between;gap:12px}",
      ".dpe_switch{box-sizing:border-box;position:relative;flex:none;width:36px;height:20px;cursor:pointer;background:var(--dsw-alias-border-l2);border:0;border-radius:10px;transition:background .15s ease;padding:0}",
      ".dpe_switch[data-on=true]{background:var(--dsw-alias-state-business-primary)}",
      ".dpe_switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:transform .15s ease}",
      ".dpe_switch[data-on=true]::after{transform:translateX(16px)}",
      ".dpe_switch:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}",
      ".dpe_switch:disabled{opacity:.5;cursor:not-allowed}",
      ".dpe_cardFoot{display:flex;align-items:center;gap:8px;padding-top:2px}",
      ".dpe_save{box-sizing:border-box;border:0;color:#fff;background:var(--dsw-alias-state-business-primary);cursor:pointer;border-radius:8px;height:30px;padding:0 16px;font-size:13px;line-height:18px}",
      ".dpe_save:disabled{opacity:.5;cursor:default}",
      ".dpe_discard{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0;cursor:pointer;border-radius:8px;height:30px;padding:0 12px;font-size:13px;line-height:18px}",
      ".dpe_discard:disabled{opacity:.5;cursor:default}",
      ".dpe_cardHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
      ".dpe_cardError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}",
      ".dpe_suggestionAnchor{display:none}",
      ".dpe_suggestion{box-sizing:border-box;position:absolute;z-index:3;display:flex;align-items:flex-start;gap:8px;margin:0;color:var(--dsw-alias-label-caption);font-family:var(--dsw-font-family);white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;pointer-events:none;user-select:none}",
      ".dpe_suggestionText{flex:1;min-width:0;overflow:hidden}",
      ".dpe_suggestionTab{box-sizing:border-box;pointer-events:auto;flex:none;height:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;padding:0 5px;cursor:pointer}",
      ".dpe_suggestionTab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".dpe_suggestionTab:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}",
      "[data-composer-card]:has(.dpe_suggestionAnchor[data-visible=true]) [data-composer-placeholder]{visibility:hidden}",
      // 加载态不覆盖输入层(会压住光标),改为让原生 placeholder 自己呼吸。
      "[data-composer-card]:has(.dpe_suggestionAnchor[data-placeholder=loading]) [data-composer-placeholder]{animation:dpe_placeholderPulse 1.3s ease-in-out infinite}",
      "@keyframes dpe_placeholderPulse{0%,100%{opacity:1}50%{opacity:.35}}",
      "@media (prefers-reduced-motion:reduce){.dpe_spinner{animation-duration:1.6s}[data-composer-card]:has(.dpe_suggestionAnchor[data-placeholder=loading]) [data-composer-placeholder]{animation:none;opacity:.6}}",
    ].join("\n");
    const TAG_ID = "@dsh-external/dsh-prompt-enhancer/style";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@dsh-external/dsh-prompt-enhancer";
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = CSS_TEXT;
      document.head.appendChild(tag);
    }

const SUGGESTION_ENDPOINT = "/prompt-enhancer/suggestion";
    const SUGGESTION_DELAY_MS = 600;
    const SUGGESTION_CACHE_MS = 5 * 60 * 1000;
    const SUGGESTION_MESSAGE_CAP = 12;
    const SUGGESTION_CLIENT_BUDGET = 24000;
    const suggestionCache = new Map();
    const suggestionSuppressed = new Map();

    function nodeText(node) {
      const data = node?.data;
      if (node?.kind === "user") {
        const blocks = Array.isArray(data?.content) ? data.content : [];
        return blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n").trim();
      }
      if (node?.kind === "assistant-step") {
        const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
        return blocks.filter((block) => block?.kind === "text" && typeof block.text === "string").map((block) => block.text).join("\n").trim();
      }
      return "";
    }

    function suggestionWindow(snapshot) {
      const chat = snapshot?.views?.get?.("chat");
      const order = Array.isArray(chat?.order) ? chat.order : [];
      const nodes = chat?.nodes;
      if (nodes === undefined || typeof nodes.get !== "function" || order.length === 0) return null;
      const visible = [];
      for (const key of order) {
        const node = nodes.get(key);
        if (node?.kind !== "user" && node?.kind !== "assistant-step") continue;
        const text = nodeText(node);
        if (text !== "") visible.push({ role: node.kind === "user" ? "user" : "assistant", text, node });
      }
      const last = visible[visible.length - 1];
      if (last === undefined || last.role !== "assistant") return null;
      const data = last.node.data ?? {};
      if (data.status !== "settled" || data.finalNode === undefined || data.interrupted === true) return null;
      const turn = data.turn;
      const location = chat.timeline?.turns?.get?.(turn);
      const turnOrder = chat.timeline?.turnOrder;
      if (location?.status !== "closed" || !Array.isArray(turnOrder) || turnOrder[turnOrder.length - 1] !== turn) return null;
      let used = 0;
      const messages = [];
      for (let i = visible.length - 1; i >= 0 && messages.length < SUGGESTION_MESSAGE_CAP && used < SUGGESTION_CLIENT_BUDGET; i -= 1) {
        const room = SUGGESTION_CLIENT_BUDGET - used;
        const text = visible[i].text.length <= room ? visible[i].text : visible[i].text.slice(0, room);
        messages.unshift({ role: visible[i].role, text });
        used += text.length;
      }
      return { turn, messages };
    }

    function syncSuggestionLayout(root, scroll, editor) {
      if (root === null || scroll === null || editor === null) return;
      const scrollRect = scroll.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      const style = getComputedStyle(editor);
      root.style.top = Math.max(0, editorRect.top - scrollRect.top + scroll.scrollTop) + "px";
      root.style.left = Math.max(0, editorRect.left - scrollRect.left) + "px";
      root.style.width = editorRect.width + "px";
      root.style.minHeight = editorRect.height + "px";
      root.style.paddingTop = style.paddingTop;
      root.style.paddingBottom = style.paddingBottom;
      root.style.paddingLeft = style.paddingLeft;
      root.style.paddingRight = style.paddingRight;
      root.style.fontSize = style.fontSize;
      root.style.lineHeight = style.lineHeight;
      root.style.fontFamily = style.fontFamily;
      root.style.letterSpacing = style.letterSpacing;
    }

    function acceptSuggestion(actions, text) {
      if (typeof actions?.captureInsertion !== "function" || typeof actions?.insertText !== "function") return false;
      const span = actions.captureInsertion();
      return actions.insertText(text, span) === true;
    }

    /* ═══════════════ 每会话控制器(两个槽条目共享同一 face 状态) ═══════════════ */
    const controllers = new Map();

    function controllerFor(sessionId) {
      let controller = controllers.get(sessionId);
      if (controller !== undefined) return controller;
      const store = createSnapshotStore({
        busy: false,
        error: null,
        original: null,
        enhanced: null,
      });
      const face = { hooks: { promptEnhancer: store } };
      controller = {
        face,
        abort: null,
        async enhance({ sessionId, draft, cwd, inputActions, t }) {
          if (store.getSnapshot().busy) return;
          store.update((state) => {
            state.busy = true;
            state.error = null;
          });
          const abort = new AbortController();
          this.abort = abort;
          try {
            // 移走焦点,防止遮罩下键盘继续输入
            try {
              const active = document.activeElement;
              if (active !== null && active !== document.body && typeof active.blur === "function") active.blur();
            } catch { /* blur 失败静默 */ }
            const res = await fetch(ENDPOINT, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({ sessionId, draft, ...(typeof cwd === "string" && cwd !== "" ? { cwd } : {}) }),
              signal: AbortSignal.any([abort.signal, AbortSignal.timeout(CLIENT_TIMEOUT_MS)]),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || typeof data.enhanced !== "string" || data.enhanced.trim() === "") {
              throw new Error(typeof data.error === "string" && data.error !== "" ? data.error : "HTTP " + res.status);
            }
            // 截断不静默:输出被 maxTokens 截断时显式告警(复用错误 toast 通道,
            // 草稿仍替换、还原入口可用),并落客户端信标
            const truncated = data.truncated === true;
            store.update((state) => {
              state.original = draft;
              state.enhanced = data.enhanced;
              if (truncated) state.error = t("truncatedWarning");
            });
            inputActions.setDraft(data.enhanced);
            if (truncated) beacon("enhance-truncated", { draftLength: draft.length });
          } catch (err) {
            if (abort.signal.aborted) return; // 用户取消:静默
            const message = err instanceof Error ? err.message : String(err);
            store.update((state) => {
              state.error = t("enhanceFailed") + ": " + message;
            });
            beacon("enhance-failed", { message });
          } finally {
            this.abort = null;
            store.update((state) => {
              state.busy = false;
            });
          }
        },
        restore({ original, inputActions }) {
          if (original === null) return;
          inputActions.setDraft(original);
          store.update((state) => {
            state.original = null;
            state.enhanced = null;
          });
        },
        cancel() {
          try {
            this.abort?.abort(new Error("用户取消强化"));
          } catch { /* abort 幂等 */ }
        },
      };
      controllers.set(sessionId, controller);
      return controller;
    }

    /* ═══════════════ 组件:强化 / 还原 按钮 + 强化中加载遮罩(挂 conversation.input.right 槽) ═══════════════ */
    function usePromptEnhancerSettings(selector) {
      const store = settingsFace?.hooks?.promptEnhancerSettings;
      if (store === undefined || typeof selector !== "function") return false;
      const [value, setValue] = useState(() => selector(store.getSnapshot()));
      useEffect(() => store.subscribe(() => setValue(selector(store.getSnapshot()))), [store]);
      return value;
    }

    function EnhanceButtons({ usePromptEnhancer, useInput, useSessions, useConversation, inputActions, sessionId, t, directory }) {
      const suggestionEnabled = usePromptEnhancerSettings((state) => state.value?.nextSuggestion === true) === true;
      const conversation = typeof useConversation === "function" ? useConversation((state) => state) : null;
      const attachmentCount = useInput((state) => (Array.isArray(state.attachmentIds) ? state.attachmentIds.length : 0));
      const phase = useInput((state) => state.phase);
      const [suggestion, setSuggestion] = useState("");
      const [loadedKey, setLoadedKey] = useState("");
      const [suggestionPhase, setSuggestionPhase] = useState("idle");
      const [scroll, setScroll] = useState(null);
      const requestSerial = useRef(0);
      const portalRef = useRef(null);
      const busy = usePromptEnhancer((state) => state.busy);
      const error = usePromptEnhancer((state) => state.error);
      const original = usePromptEnhancer((state) => state.original);
      const enhanced = usePromptEnhancer((state) => state.enhanced);
      const draft = useInput((state) => state.draft) ?? "";
      const cwd = useSessions((state) => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd));
      const toastTimer = useRef(null);

      useEffect(() => () => {
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
      }, []);

      // 诊断:组件成功挂载
      useEffect(() => {
        beacon("mounted", { sessionId, hasInput: typeof useInput === "function", hasActions: typeof inputActions?.setDraft === "function" });
      }, []);

      // 错误 toast 自动消失
      useEffect(() => {
        if (error === null) return;
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => {
          controllerFor(sessionId).face.hooks.promptEnhancer.update((state) => {
            state.error = null;
          });
        }, 4000);
        return () => {
          if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        };
      }, [error, sessionId]);

      const controller = controllerFor(sessionId);
      // 还原入口:仅强化成功且草稿仍是增强文本(严格版)时显示
      const canRestore = !busy && original !== null && enhanced !== null && draft === enhanced;
      const empty = draft.trim() === "";
      // slot 组件拿不到 modelDirectories 服务本身;Codex 插件把 directoryFor(sessionId).store
      // 显式塞进 overlay props。我们同样从闭包注入 directory,避免读到 undefined 后永远不让路。
      const modelSelection = useSyncExternalStore(
        (listener) => typeof directory?.subscribe === "function" ? directory.subscribe(listener) : () => {},
        () => directory?.getSnapshot?.()?.current ?? null,
        () => null,
      );
      const settled = suggestionWindow(conversation);
      const turnKey = settled === null || sessionId === undefined ? "" : sessionId + ":" + settled.turn;
      const dismissed = turnKey !== "" && suggestionSuppressed.get(sessionId) === turnKey;
      const consumed = suggestionConsumed(suggestion, draft);
      // Codex 层只在有预测文本后才挂 DOM,等它出现再让路会叠两层。白名单模型会话直接让路。
      const codexOwned = codexPredictionOwns({
        provider: modelSelection?.provider,
        model: modelSelection?.model,
      });
      const view = suggestionView({
        enabled: suggestionEnabled,
        busy,
        empty,
        attachmentCount,
        composerPhase: phase,
        turnKey,
        dismissed,
        consumed,
        codexOwned,
        phase: suggestionPhase,
        suggestion,
        loadedKey,
      });
      const visible = view.showText && scroll !== null;

      const acceptCurrent = () => {
        if (!visible) return false;
        return acceptSuggestion(inputActions, suggestion);
      };

      useEffect(() => {
        const card = document.querySelector("[data-composer-card]");
        setScroll(card?.querySelector("[data-input-scroll]") ?? null);
      }, [sessionId, view.placeholder, conversation]);

      useEffect(() => {
        if (!visible || portalRef.current === null || scroll === null) return undefined;
        const editor = scroll.querySelector("[data-composer-input]");
        const place = () => syncSuggestionLayout(portalRef.current, scroll, editor);
        place();
        const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
        if (editor !== null) observer?.observe(editor);
        observer?.observe(scroll);
        scroll.addEventListener("scroll", place);
        return () => {
          observer?.disconnect();
          scroll.removeEventListener("scroll", place);
        };
      }, [visible, scroll, suggestion]);

      useEffect(() => {
        // 只清掉属于别的回合的旧建议:正在显示本回合结果时 view.request 也是 false,
        // 在这里清会把刚显示的建议擦掉(表现为一闪而过)。
        const action = suggestionSync({ turnKey, loadedKey, request: view.request === true && settled !== null });
        if (action === "clear") {
          if (loadedKey !== "") {
            setSuggestion("");
            setLoadedKey("");
            setSuggestionPhase("idle");
          }
          return undefined;
        }
        if (action === "hold") return undefined;
        const cached = suggestionCache.get(turnKey);
        if (cached !== undefined && Date.now() - cached.at < SUGGESTION_CACHE_MS) {
          setSuggestion(cached.text);
          setLoadedKey(turnKey);
          setSuggestionPhase(cached.text === "" ? "failed" : "ready");
          return undefined;
        }
        const serial = requestSerial.current + 1;
        requestSerial.current = serial;
        const abort = new AbortController();
        const timer = setTimeout(() => {
          setSuggestionPhase("loading");
          fetch(SUGGESTION_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ sessionId, turn: settled.turn, messages: settled.messages }),
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(70000)]),
          }).then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (requestSerial.current !== serial || abort.signal.aborted) return;
            if (!res.ok || typeof data.suggestion !== "string" || data.suggestion.trim() === "") {
              suggestionCache.set(turnKey, { text: "", at: Date.now() });
              setSuggestion("");
              setLoadedKey(turnKey);
              setSuggestionPhase("failed");
              if (!res.ok) beacon("suggestion-failed", { status: res.status });
              return;
            }
            suggestionCache.set(turnKey, { text: data.suggestion, at: Date.now() });
            setSuggestion(data.suggestion);
            setLoadedKey(turnKey);
            setSuggestionPhase("ready");
          }).catch((err) => {
            if (requestSerial.current !== serial || err?.name === "AbortError") return;
            suggestionCache.set(turnKey, { text: "", at: Date.now() });
            setSuggestion("");
            setLoadedKey(turnKey);
            setSuggestionPhase("failed");
            beacon("suggestion-failed", { message: String(err?.message ?? err) });
          });
        }, SUGGESTION_DELAY_MS);
        return () => {
          clearTimeout(timer);
          abort.abort();
        };
      }, [view.request, turnKey, loadedKey, sessionId]);

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === "Escape" && visible) {
            suggestionSuppressed.set(sessionId, turnKey);
            setSuggestion("");
            return;
          }
          if (event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.defaultPrevented) return;
          const editor = scroll?.querySelector("[data-composer-input]") ?? null;
          if (editor === null || (document.activeElement !== editor && !editor.contains(document.activeElement))) return;
          if (!visible) return;
          event.preventDefault();
          acceptCurrent();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
      }, [visible, suggestion, scroll, sessionId, turnKey]);

      const onEnhance = () => {
        if (busy || empty) return;
        void controller.enhance({ sessionId, draft, cwd, inputActions, t });
      };

      const onRestore = () => {
        controller.restore({ original, inputActions });
      };

      return jsx("div", {
        className: "dpe_root",
        "data-prompt-enhancer": "",
        "aria-busy": busy,
        children: [
          jsx("span", {
            className: "dpe_suggestionAnchor",
            "data-visible": visible ? "true" : undefined,
            "data-placeholder": view.placeholder === "loading" ? "loading" : undefined,
            "data-prompt-enhancer-suggestion": "",
          }),
          visible ? createPortal(jsx("div", {
            ref: portalRef,
            className: "dpe_suggestion",
            children: [
              jsx("span", { className: "dpe_suggestionText", children: suggestion }),
              jsx("button", {
                type: "button",
                className: "dpe_suggestionTab",
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => acceptCurrent(),
                children: "Tab",
              }),
            ],
          }), scroll) : null,
          jsx("button", {
            type: "button",
            className: "dpe_iconButton",
            title: t("enhance"),
            "aria-label": t("enhance"),
            disabled: busy || empty,
            onClick: onEnhance,
            children: busy ? jsx("span", { className: "dpe_spinner", "aria-hidden": true }) : iconSvg(SPARKLE_PATHS),
          }),
          canRestore
            ? jsx("button", {
                type: "button",
                className: "dpe_iconButton",
                title: t("restore"),
                "aria-label": t("restore"),
                onClick: onRestore,
                children: iconSvg(UNDO_PATH),
              })
            : null,
          busy
            ? jsx("div", {
                className: "dpe_mask",
                role: "status",
                children: [
                  jsx("span", { className: "dpe_spinner", "aria-hidden": true }),
                  jsx("span", { className: "dpe_maskLabel", children: t("enhancing") }),
                  jsx("button", { type: "button", className: "dpe_cancel", onClick: () => controller.cancel(), children: t("cancel") }),
                ],
              })
            : null,
          error !== null ? jsx("div", { className: "dpe_toast", role: "status", children: error }) : null,
        ],
      });
    }

    let settingsFace = null;

    /* ═══════════════ 设置卡片:强化模型 + 强化程度(设置 → 插件 → 插件配置) ═══════════════ */
    const SETTINGS_NS = "prompt-enhancer";
    const MODELS_ENDPOINT = "/prompt-enhancer/models";
    const INTENSITIES = ["low", "medium", "high"];

    /** 每插件单例控制器:Config 表单 + 模型目录拉取 + staged 表单。
     *  0.2.x 起设置表单由宿主 configForms 服务提供(dsh-client-ui-settings):
     *  get(namespace) 返回 ConfigFormController,namespace 是 profile patch 里的
     *  entry id(与本插件 SETTINGS_NS 一致),不是包名。 */
    function settingsCardControllerFor(ctx) {
      const scope = ctx.configForms.get(SETTINGS_NS);
      const store = createSnapshotStore({
        status: "loading", // loading | ready | unavailable
        writable: true,
        value: {},
        user: {},
        staged: {}, // model: null(清除)|{provider,model,reasoningEffort?}|undefined(未动);intensity 同理
        saving: false,
        failed: false,
        modelsStatus: "idle", // idle | loading | ready | error
        modelsGroups: [],
        modelsFailed: null,
      });

      const publish = () => {
        const snapshot = scope.getSnapshot();
        store.update((state) => {
          state.status = snapshot.status;
          state.writable = snapshot.writable;
          state.value = snapshot.value ?? {};
          state.user = snapshot.user ?? {};
        });
      };
      // 订阅跟随插件生命周期(effect 的 dispose = configForms 的 unsubscribe),
      // 避免 HMR/停用插件后仍持有宿主 mirror 订阅。
      ctx.effect(() => scope.subscribe(publish), "@dsh-external/dsh-prompt-enhancer: settings store");
      publish();

      let modelsGeneration = 0;
      const loadModels = () => {
        const generation = ++modelsGeneration;
        store.update((state) => {
          state.modelsStatus = "loading";
          state.modelsFailed = null;
        });
        const applyGroups = (groups) => {
          if (generation !== modelsGeneration) return;
          store.update((state) => {
            state.modelsGroups = groups;
            state.modelsStatus = "ready";
          });
        };
        const fail = (err) => {
          if (generation !== modelsGeneration) return;
          store.update((state) => {
            state.modelsStatus = "error";
            state.modelsFailed = err instanceof Error ? err.message : String(err);
          });
        };
        // 设置卡片不在会话槽,不得碰 session 子服务(可选链也会被 cordis 判未注入)。
        // 目录走本插件 GET /models(已合并 listProviders + listConfigurableProviders);
        // 刷新仍用已注入的 ctx.remote.$on。
        fetch(MODELS_ENDPOINT, { headers: { accept: "application/json" } })
          .then((res) => res.json().catch(() => ({})))
          .then(catalogGroupsFromRemote)
          .then(applyGroups)
          .catch(fail);
      };
      loadModels();
      ctx.effect(() => {
        const remote = ctx.remote;
        if (remote === undefined || typeof remote.$on !== "function") return undefined;
        const reload = () => loadModels();
        const offs = [
          remote.$on("llm/adapters-updated", reload),
          remote.$on("llm/models-updated", reload),
          remote.$on("settings/document-updated", reload),
          remote.$on("credentials/record-updated", reload),
          remote.$on("credentials/reference-updated", reload),
        ];
        return () => {
          for (const off of offs) if (typeof off === "function") off();
        };
      }, "@dsh-external/dsh-prompt-enhancer: catalog refresh");

      const editModel = (selection) => {
        store.update((state) => {
          state.staged = { ...state.staged, model: selection };
        });
      };
      const editIntensity = (value) => {
        store.update((state) => {
          state.staged = { ...state.staged, intensity: value };
        });
      };
      const editOutputEnglish = (value) => {
        store.update((state) => {
          state.staged = { ...state.staged, outputEnglish: Boolean(value) };
        });
      };
      const editNextSuggestion = (value) => {
        store.update((state) => {
          state.staged = { ...state.staged, nextSuggestion: Boolean(value) };
        });
      };
      const save = async () => {
        const snapshot = store.getSnapshot();
        if (snapshot.saving || !snapshot.writable) return;
        store.update((state) => {
          state.saving = true;
          state.failed = false;
        });
        let landed = true;
        const staged = { ...snapshot.staged };
        if (Object.hasOwn(staged, "model")) {
          const selection = staged.model;
          try {
            if (selection === null) {
              // ConfigFormController 的写操作返回 boolean(宿主是否接受),不抛异常:
              // 被拒(如并发 revision 冲突且 recover 失败)时必须显式判 false。
              if (await scope.unset("model") === false) landed = false;
              landed = landed && !Object.hasOwn(scope.getSnapshot().user ?? {}, "model");
            } else {
              if (await scope.set("model", selection) === false) landed = false;
              const stored = scope.getSnapshot().user?.model;
              landed =
                landed &&
                stored !== undefined &&
                stored.provider === selection.provider &&
                stored.model === selection.model &&
                (selection.reasoningEffort === undefined || stored.reasoningEffort === selection.reasoningEffort);
            }
          } catch {
            landed = false;
          }
        }
        if (Object.hasOwn(staged, "intensity") && staged.intensity !== snapshot.value.intensity) {
          try {
            if (await scope.set("intensity", staged.intensity) === false) landed = false;
            landed = landed && scope.getSnapshot().user?.intensity === staged.intensity;
          } catch {
            landed = false;
          }
        }
        if (Object.hasOwn(staged, "outputEnglish") && staged.outputEnglish !== (snapshot.value.outputEnglish === true)) {
          try {
            if (await scope.set("outputEnglish", staged.outputEnglish) === false) landed = false;
            landed = landed && (scope.getSnapshot().user?.outputEnglish === true) === staged.outputEnglish;
          } catch {
            landed = false;
          }
        }
        if (Object.hasOwn(staged, "nextSuggestion") && staged.nextSuggestion !== (snapshot.value.nextSuggestion === true)) {
          try {
            if (await scope.set("nextSuggestion", staged.nextSuggestion) === false) landed = false;
            landed = landed && (scope.getSnapshot().user?.nextSuggestion === true) === staged.nextSuggestion;
          } catch {
            landed = false;
          }
        }
        store.update((state) => {
          state.saving = false;
          state.failed = !landed;
          if (landed) state.staged = {};
        });
      };
      const discard = () => {
        store.update((state) => {
          state.staged = {};
          state.failed = false;
        });
      };

      return {
        face: {
          hooks: { promptEnhancerSettings: store },
          editModel,
          editIntensity,
          editOutputEnglish,
          editNextSuggestion,
          save,
          discard,
          loadModels,
        },
      };
    }

    /** 设置卡片组件:模型三级联动(provider→model→effort)+ 强度三档 + 转换英文开关。
     *  face 注入的 editModel/editIntensity/editOutputEnglish/save/discard/loadModels 以顶层 props 到达。 */
    function SettingsCard({ usePromptEnhancerSettings, t, editModel, editIntensity, editOutputEnglish, editNextSuggestion, save, discard, loadModels }) {
      const state = usePromptEnhancerSettings((snapshot) => snapshot);

      // 打开设置页即拉取模型目录
      useEffect(() => {
        loadModels();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const stagedModel = Object.hasOwn(state.staged, "model") ? state.staged.model : (state.value.model ?? null);
      const stagedIntensity = Object.hasOwn(state.staged, "intensity") ? state.staged.intensity : (state.value.intensity ?? "medium");
      const stagedOutputEnglish = Object.hasOwn(state.staged, "outputEnglish") ? state.staged.outputEnglish === true : state.value.outputEnglish === true;
      const stagedNextSuggestion = Object.hasOwn(state.staged, "nextSuggestion") ? state.staged.nextSuggestion === true : state.value.nextSuggestion === true;
      const selectedProvider = stagedModel?.provider ?? "";
      const providerGroup = state.modelsGroups.find((group) => group.id === selectedProvider) ?? null;
      const selectedModelId = stagedModel?.model ?? "";
      const selectedEntry = providerGroup?.models.find((entry) => entry.id === selectedModelId) ?? null;
      const efforts = selectedEntry?.reasoning?.efforts ?? [];
      const selectedEffort = stagedModel?.reasoningEffort ?? "";

      const readonly = !state.writable || state.status !== "ready";
      const modelsReady = state.modelsStatus === "ready" && state.modelsGroups.length > 0;

      const onProviderChange = (value) => {
        if (value === "") {
          editModel(null);
          return;
        }
        const group = state.modelsGroups.find((candidate) => candidate.id === value);
        if (group === undefined) return;
        const keep = group.models.some((entry) => entry.id === stagedModel?.model) ? stagedModel.model : group.models[0]?.id ?? "";
        editModel({ provider: value, model: keep, reasoningEffort: "" });
      };
      const onModelChange = (id) => {
        editModel({ provider: selectedProvider, model: id, reasoningEffort: "" });
      };
      const onEffortChange = (id) => {
        editModel({ provider: selectedProvider, model: selectedModelId, reasoningEffort: id === "" ? undefined : id });
      };

      // 注意:schema 默认 model=null(而非 undefined),比较前必须先排除 null
      const modelDirty =
        Object.hasOwn(state.staged, "model") &&
        (stagedModel === null
          ? state.value.model !== undefined && state.value.model !== null
          : state.value.model === undefined ||
            state.value.model === null ||
            stagedModel.provider !== state.value.model.provider ||
            stagedModel.model !== state.value.model.model ||
            (stagedModel.reasoningEffort ?? "") !== (state.value.model.reasoningEffort ?? ""));
      const intensityDirty = Object.hasOwn(state.staged, "intensity") && stagedIntensity !== state.value.intensity;
      const outputEnglishDirty = Object.hasOwn(state.staged, "outputEnglish") && stagedOutputEnglish !== (state.value.outputEnglish === true);
      const nextSuggestionDirty = Object.hasOwn(state.staged, "nextSuggestion") && stagedNextSuggestion !== (state.value.nextSuggestion === true);
      const dirty = modelDirty || intensityDirty || outputEnglishDirty || nextSuggestionDirty;

      const modelField = jsx("div", {
        className: "dpe_field",
        children: [
          jsx("span", { className: "dpe_fieldLabel", children: t("modelLabel") }),
          jsx("select", {
            className: "dpe_select",
            value: selectedProvider,
            disabled: readonly || !modelsReady,
            onChange: (event) => onProviderChange(event.target.value),
            children: [
              jsx("option", { value: "", children: t("modelFollowSession") }),
              ...state.modelsGroups.map((group) =>
                jsx("option", { key: group.id, value: group.id, children: group.name + " · " + group.id })
              ),
            ],
          }),
          selectedProvider !== "" && providerGroup !== null
            ? jsx("select", {
                className: "dpe_select",
                value: selectedModelId,
                disabled: readonly,
                onChange: (event) => onModelChange(event.target.value),
                children: providerGroup.models.map((entry) => jsx("option", { key: entry.id, value: entry.id, children: entry.name })),
              })
            : null,
          selectedProvider !== "" && selectedEntry !== null && efforts.length > 0
            ? jsx("select", {
                className: "dpe_select",
                value: selectedEffort,
                disabled: readonly,
                onChange: (event) => onEffortChange(event.target.value),
                children: [
                  jsx("option", { value: "", children: t("effortDefault") }),
                  ...efforts.map((effort) => jsx("option", { key: effort.id, value: effort.id, children: effort.name })),
                ],
              })
            : null,
          state.modelsStatus === "loading"
            ? jsx("span", { className: "dpe_cardHint", children: t("modelsLoading") })
            : state.modelsStatus === "error"
              ? jsx("span", { className: "dpe_cardError", children: t("modelsFailed") + (state.modelsFailed !== null ? ": " + state.modelsFailed : "") })
              : state.modelsStatus === "ready" && state.modelsGroups.length === 0
                ? jsx("span", { className: "dpe_cardHint", children: t("modelsEmpty") })
                : null,
        ],
      });

      const intensityField = jsx("div", {
        className: "dpe_field",
        children: [
          jsx("span", { className: "dpe_fieldLabel", children: t("intensityLabel") }),
          jsx("div", {
            className: "dpe_radioRow",
            children: INTENSITIES.map((level) =>
              jsx("button", {
                key: level,
                type: "button",
                className: "dpe_radio",
                "data-on": stagedIntensity === level ? "true" : undefined,
                disabled: readonly,
                onClick: () => editIntensity(level),
                children: [
                  jsx("span", { children: t("intensity" + level[0].toUpperCase() + level.slice(1)) }),
                  jsx("small", { children: t("intensity" + level[0].toUpperCase() + level.slice(1) + "Hint") }),
                ],
              })
            ),
          }),
        ],
      });

      const outputEnglishField = jsx("div", {
        className: "dpe_field",
        children: [
          jsx("div", {
            className: "dpe_toggleRow",
            children: [
              jsx("span", { className: "dpe_fieldLabel", children: t("outputEnglishLabel") }),
              jsx("button", {
                type: "button",
                role: "switch",
                "aria-checked": stagedOutputEnglish,
                "aria-label": t("outputEnglishLabel"),
                className: "dpe_switch",
                "data-on": stagedOutputEnglish ? "true" : undefined,
                disabled: readonly,
                onClick: () => editOutputEnglish(!stagedOutputEnglish),
              }),
            ],
          }),
          jsx("span", { className: "dpe_cardHint", children: t("outputEnglishHint") }),
        ],
      });

      const nextSuggestionField = jsx("div", {
        className: "dpe_field",
        children: [
          jsx("div", {
            className: "dpe_toggleRow",
            children: [
              jsx("span", { className: "dpe_fieldLabel", children: t("nextSuggestionLabel") }),
              jsx("button", {
                type: "button",
                role: "switch",
                "aria-checked": stagedNextSuggestion,
                "aria-label": t("nextSuggestionLabel"),
                className: "dpe_switch",
                "data-on": stagedNextSuggestion ? "true" : undefined,
                disabled: readonly,
                onClick: () => editNextSuggestion(!stagedNextSuggestion),
              }),
            ],
          }),
          jsx("span", { className: "dpe_cardHint", children: t("nextSuggestionHint") }),
        ],
      });

      return jsx("div", {
        className: "dpe_card",
        "data-prompt-enhancer-settings": "",
        children: [
          jsx("div", {
            className: "dpe_cardHead",
            children: [
              jsx("span", { className: "dpe_cardTitle", children: t("settingsTitle") }),
              jsx("span", { className: "dpe_cardDesc", children: t("settingsDescription") }),
            ],
          }),
          modelField,
          intensityField,
          outputEnglishField,
          nextSuggestionField,
          state.failed ? jsx("span", { className: "dpe_cardError", children: t("saveFailed") }) : null,
          jsx("div", {
            className: "dpe_cardFoot",
            children: [
              dirty ? jsx("span", { className: "dpe_cardHint", children: t("unsaved") }) : null,
              jsx("button", {
                type: "button",
                className: "dpe_save",
                disabled: !dirty || state.saving || readonly,
                onClick: () => {
                  void save();
                },
                children: state.saving ? t("saving") : t("save"),
              }),
              jsx("button", {
                type: "button",
                className: "dpe_discard",
                disabled: (!dirty && !state.failed) || state.saving || readonly,
                onClick: () => discard(),
                children: t("discard"),
              }),
            ],
          }),
        ],
      });
    }

    /* ═══════════════ 插件入口 ═══════════════ */
    // configForms/connection/remote 必须在静态 inject 声明:cordis 严格模式下
    // 属性访问未注入的服务会抛 "cannot get property X without inject"(实测)。
    // 本部署 ui-settings 提供 configForms,设置卡片依赖它;服务缺失时整个插件
    // fiber 会挂起等待——与官方 ui-settings-plugins 的行为一致,属合理依赖。
    const inject = ["slots", "conversation", "locale", "configForms", "connection", "remote", "modelDirectories"];

    const zh = {
      enhance: "强化提示词",
      restore: "还原为原始提示词",
      enhanceFailed: "强化失败",
      truncatedWarning: "⚠ 强化输出被截断（达到 maxTokens 上限）：增强稿可能不完整、参考文件可能缺失，如不合适请点还原。",
      enhancing: "正在强化提示词…",
      cancel: "取消",
      settingsTitle: "提示词强化",
      settingsDescription: "配置「强化」使用的模型、输出强度、输出语言，以及下一轮建议。",
      modelLabel: "强化模型",
      modelFollowSession: "跟随会话默认（推荐）",
      modelProvider: "提供方",
      modelName: "模型",
      effortLabel: "思考强度",
      effortDefault: "模型默认",
      intensityLabel: "强化程度",
      intensityLow: "低",
      intensityLowHint: "精简润色，不附文件引用",
      intensityMedium: "中",
      intensityMediumHint: "标准优化，参考文件仅列路径",
      intensityHigh: "高",
      intensityHighHint: "充分展开，可附参考文件",
      outputEnglishLabel: "转换英文",
      outputEnglishHint: "开启后，强化结果将自动输出为英文提示词（参考文件节标题为「## Reference Files」）。",
      nextSuggestionLabel: "下一轮建议",
      nextSuggestionHint: "一轮结束后，在空输入框显示一条可继续发送的草稿。Tab 填入，不自动发送。会额外调用模型。",
      save: "保存",
      saving: "保存中…",
      discard: "放弃修改",
      unsaved: "未保存",
      saveFailed: "本部署没有接受这些值，已保留供你修改。",
      modelsLoading: "正在加载模型列表…",
      modelsFailed: "模型列表加载失败",
      modelsEmpty: "当前没有可用的模型",
      readOnly: "本部署的设置为只读。",
    };
    const en = {
      enhance: "Enhance prompt",
      restore: "Restore original prompt",
      enhanceFailed: "Enhancement failed",
      truncatedWarning: "⚠ Enhanced output was truncated (max tokens reached): the draft may be incomplete. Use restore if it looks cut off.",
      enhancing: "Enhancing prompt…",
      cancel: "Cancel",
      settingsTitle: "Prompt Enhancer",
      settingsDescription: "Configure the model, intensity, output language, and next-turn suggestion used by Enhance.",
      modelLabel: "Enhancement model",
      modelFollowSession: "Follow session default (recommended)",
      modelProvider: "Provider",
      modelName: "Model",
      effortLabel: "Reasoning effort",
      effortDefault: "Model default",
      intensityLabel: "Enhancement intensity",
      intensityLow: "Low",
      intensityLowHint: "Light polish, no file references",
      intensityMedium: "Medium",
      intensityMediumHint: "Standard rewrite, path-only references",
      intensityHigh: "High",
      intensityHighHint: "Full expansion, may include references",
      outputEnglishLabel: "Translate to English",
      outputEnglishHint: "When on, the enhanced prompt is always output in English (reference section heading becomes “## Reference Files”).",
      nextSuggestionLabel: "Next suggestion",
      nextSuggestionHint: "After a turn ends, show one continuable draft in the empty input. Tab fills it and does not send. This makes an extra model call.",
      save: "Save",
      saving: "Saving…",
      discard: "Discard",
      unsaved: "Unsaved",
      saveFailed: "The deployment did not accept these values; they were left for you to correct.",
      modelsLoading: "Loading models…",
      modelsFailed: "Failed to load models",
      modelsEmpty: "No models available",
      readOnly: "This deployment stores settings read-only.",
    };

    function apply(ctx) {
      beacon("apply");
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "@dsh-external/dsh-prompt-enhancer: dictionaries");
      } catch (err) {
        beacon("apply-error-locale", { message: String(err?.message ?? err) });
        throw err;
      }
      // 诊断:捕获槽条目渲染崩溃(渲染器会 abdicate 静默,这里是唯一取证口)
      try {
        ctx.effect(() => ctx.slots.onEntryError((key, entry, error, info) => {
          beacon("slot-entry-error", {
            key,
            entryId: entry?.options?.id ?? "unknown",
            message: String(error?.message ?? error),
            stack: String(error?.stack ?? "").slice(0, 600),
            abdicated: info?.abdicated === true,
          });
        }), "@dsh-external/dsh-prompt-enhancer: entry-error diag");
      } catch (err) {
        beacon("onEntryError-install-failed", { message: String(err?.message ?? err) });
      }
      ctx.effect(() => ctx.slots.inject("conversation.input.right", () => {
        beacon("slot-declared-callback");
        return ctx.slots.register({
          name: "conversation.input.right",
          id: "prompt-enhancer-buttons",
          order: 60,
          locale: NS,
          inject: (sessionId) => ({
            ...controllerFor(sessionId).face,
            ...(settingsFace === null ? {} : { hooks: { ...controllerFor(sessionId).face.hooks, ...settingsFace.hooks } }),
            directory: ctx.get("modelDirectories")?.directoryFor?.(sessionId)?.store,
          }),
        }, EnhanceButtons);
      }), "@dsh-external/dsh-prompt-enhancer: input buttons");
      // 设置卡片(设置 → 内置插件 → 「提示词强化」Tab):0.2.x 起 settings.plugin.item
      // 槽位已不存在,官方开放的是 settings.plugins.tab(list 槽,注册项用 id 而非 key)。
      // 用 configForms.whileServed 跟随宿主是否真的服务该 namespace:未服务时不注册,
      // 免得用户看到一个永远空白的 Tab(与官方 ui-settings-* 的接线同构)。
      try {
        const settingsCard = settingsCardControllerFor(ctx);
        settingsFace = settingsCard.face;
        ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
          name: "settings.plugins.tab",
          id: SETTINGS_NS,
          label: () => ctx.locale.bind(NS)("settingsTitle"),
          locale: NS,
          inject: () => settingsCard.face,
        }, SettingsCard))), "@dsh-external/dsh-prompt-enhancer: settings card");
      } catch (error) {
        beacon("settings-card-failed", { message: String(error?.message ?? error) });
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
