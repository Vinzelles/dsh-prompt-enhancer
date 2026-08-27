# 验收清单（10 项功能基线，发布/回归自查）

1. 输入框右侧出现「强化」图标；草稿为空时禁用。
2. 点击强化 → 图标转 spinner → 输入卡片出现加载遮罩（含「取消」按钮，输入被锁定）→ 草稿被增强文本替换（手动发送）。
3. 强化成功后出现「还原」；点击还原草稿回退原文且还原消失。
4. 手动编辑草稿 / 发送消息后还原消失（严格触发）。
5. 强化期间点「取消」：遮罩消失、草稿保持原文、host 端子代理被中止。
6. 参考文件清单均为真实存在的文件（路径臆造会被自动剔除）；无仓库/零命中时无该节（静默降级）。
7. 失败/超时 toast 提示，原文保留，可重试。
8. 设置 → 插件 → 插件配置出现「提示词强化」卡片：模型下拉含「跟随会话默认」+ 全部 provider/模型/思考强度；强度三档可切换；保存后写 settings 文档。
9. 强度设为「低」后强化：输出精简且不含「## 参考文件」节；「中」仅列参考路径；「高」恢复完整引用（路径 + 说明）。
10. 配置专用模型后强化：diag log `enhance-start` 的 `model` 字段与宿主 `debug-stream.log` 的 `buildRequest done: provider=..., model=...` 显示该模型。
11. 运行在非标准 agent 预设上的会话点击强化不报错（2026-08-21 回归）：父预设首轮机制与子会话不兼容时（diag log `enhance-child-no-text` 后出现 `enhance-child-retry-bare`），无预设子会话自动重试成功，toast 不再出现「LLM 无输出」；标准/code 等无首轮机制预设首轮即成功（无 retry 记录）。
14. 截断检测（2026-08-27）：任一通道输出被 maxTokens 截断时——通道 A（llm 直调）捕获 finish 块 `reason.kind === "max-tokens"`；通道 B（子会话）由 `childOutputTruncated` 判定最终文本来源步的 finish 块——响应 JSON 携带 `truncated: true`，UI 弹显式告警 toast（增强稿仍替换、「还原 ↺」可用），host 落 `enhance-truncated` 信标（含通道与草稿长度）、client 落同名信标。未截断时响应无 `truncated` 字段、UI 无告警（1–13 项行为不变）。
13. 访问控制（2026-08-27）：非本机来源（非 `127.0.0.1`/`::1`/`::ffff:127.0.0.1`）调用 `/prompt-enhancer`、`/prompt-enhancer/models`、`/prompt-enhancer/diag` 任一端点，立即 403 且不执行业务逻辑（diag log 落 `foreign-request-rejected` 信标含来源地址）；本机来源一切行为正常（1–12 项全部成立）。缺失 socket 信息按非本机处理（fail-closed）。
