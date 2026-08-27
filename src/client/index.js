window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-prompt-enhancer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const { jsx } = require("react/jsx-runtime");
    const { useState, useRef, useEffect } = require("react");
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-runtime/client");

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
    const CLIENT_TIMEOUT_MS = 160000; // 通道 B 90s + 通道 A 60s = 150s 全链路 + 余量

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
      ".dpe_cardFoot{display:flex;align-items:center;gap:8px;padding-top:2px}",
      ".dpe_save{box-sizing:border-box;border:0;color:#fff;background:var(--dsw-alias-state-business-primary);cursor:pointer;border-radius:8px;height:30px;padding:0 16px;font-size:13px;line-height:18px}",
      ".dpe_save:disabled{opacity:.5;cursor:default}",
      ".dpe_discard{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0;cursor:pointer;border-radius:8px;height:30px;padding:0 12px;font-size:13px;line-height:18px}",
      ".dpe_discard:disabled{opacity:.5;cursor:default}",
      ".dpe_cardHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
      ".dpe_cardError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}",
      "@media (prefers-reduced-motion:reduce){.dpe_spinner{animation-duration:1.6s}}",
    ].join("\n");
    const TAG_ID = "@dsh-external/dsh-prompt-enhancer/style";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@dsh-external/dsh-prompt-enhancer";
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = CSS_TEXT;
      document.head.appendChild(tag);
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
            store.update((state) => {
              state.original = draft;
              state.enhanced = data.enhanced;
            });
            inputActions.setDraft(data.enhanced);
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
    function EnhanceButtons({ usePromptEnhancer, useInput, useSessions, inputActions, sessionId, t }) {
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

    /* ═══════════════ 设置卡片:强化模型 + 强化程度(设置 → 插件 → 插件配置) ═══════════════ */
    const SETTINGS_NS = "prompt-enhancer";
    const MODELS_ENDPOINT = "/prompt-enhancer/models";
    const INTENSITIES = ["low", "medium", "high"];

    /** 每插件单例控制器:settingsScope 绑定 + 模型目录拉取 + staged 表单。 */
    function settingsCardControllerFor(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
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
      scope.subscribe(publish);
      publish();

      const loadModels = () => {
        store.update((state) => {
          state.modelsStatus = "loading";
          state.modelsFailed = null;
        });
        fetch(MODELS_ENDPOINT, { headers: { accept: "application/json" } })
          .then((res) => res.json().catch(() => ({})))
          .then((data) => {
            if (!Array.isArray(data?.groups)) throw new Error("bad payload");
            store.update((state) => {
              state.modelsGroups = data.groups;
              state.modelsStatus = "ready";
            });
          })
          .catch((err) => {
            store.update((state) => {
              state.modelsStatus = "error";
              state.modelsFailed = err instanceof Error ? err.message : String(err);
            });
          });
      };

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
              await scope.unset("model");
              landed = landed && !Object.hasOwn(scope.getSnapshot().user ?? {}, "model");
            } else {
              await scope.set("model", selection);
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
            await scope.set("intensity", staged.intensity);
            landed = landed && scope.getSnapshot().user?.intensity === staged.intensity;
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
          save,
          discard,
          loadModels,
        },
      };
    }

    /** 设置卡片组件:模型三级联动(provider→model→effort)+ 强度三档。
     *  face 注入的 editModel/editIntensity/save/discard/loadModels 以顶层 props 到达。 */
    function SettingsCard({ usePromptEnhancerSettings, t, editModel, editIntensity, save, discard, loadModels }) {
      const state = usePromptEnhancerSettings((snapshot) => snapshot);

      // 打开设置页即拉取模型目录
      useEffect(() => {
        loadModels();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const stagedModel = Object.hasOwn(state.staged, "model") ? state.staged.model : (state.value.model ?? null);
      const stagedIntensity = Object.hasOwn(state.staged, "intensity") ? state.staged.intensity : (state.value.intensity ?? "medium");
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
      const dirty = modelDirty || intensityDirty;

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
    // settingsScope/connection/remote 必须在静态 inject 声明:cordis 严格模式下
    // 属性访问未注入的服务会抛 "cannot get property X without inject"(实测)。
    // 本部署 ui-settings 提供 settingsScope,设置卡片依赖它;服务缺失时整个插件
    // fiber 会挂起等待——与官方 ui-settings-plugins 的行为一致,属合理依赖。
    const inject = ["slots", "conversation", "locale", "settingsScope", "connection", "remote"];

    const zh = {
      enhance: "强化提示词",
      restore: "还原为原始提示词",
      enhanceFailed: "强化失败",
      enhancing: "正在强化提示词…",
      cancel: "取消",
      settingsTitle: "提示词强化",
      settingsDescription: "配置「强化」使用的模型与输出强度。",
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
      enhancing: "Enhancing prompt…",
      cancel: "Cancel",
      settingsTitle: "Prompt Enhancer",
      settingsDescription: "Configure the model and output intensity used by Enhance.",
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
          inject: (sessionId) => controllerFor(sessionId).face,
        }, EnhanceButtons);
      }), "@dsh-external/dsh-prompt-enhancer: input buttons");
      // 设置卡片(设置 → 插件 → 插件配置):key 必须等于 host 注册的 settings 命名空间
      try {
        const settingsCard = settingsCardControllerFor(ctx);
        ctx.effect(() => ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
          name: "settings.plugin.item",
          key: SETTINGS_NS,
          locale: NS,
          inject: () => settingsCard.face,
        }, SettingsCard)), "@dsh-external/dsh-prompt-enhancer: settings card");
      } catch (error) {
        beacon("settings-card-failed", { message: String(error?.message ?? error) });
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
