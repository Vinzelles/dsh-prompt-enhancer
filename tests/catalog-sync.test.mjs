// 设置卡片模型目录同步:与宿主选择器同源(listProviders + listConfigurableProviders 去重,
// RemoteResult / HTTP JSON 两种载荷都能抽出 groups)。
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const host = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const client = readFileSync(new URL("../src/client/index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error("marker not found: " + startMarker);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error("end marker not found: " + endMarker);
  return src.slice(start, end);
}

const catalogFn = slice(host, "function catalogProviderInfos", "\n}\n") + "\n}\n";
const { catalogProviderInfos } = new Function(catalogFn + "\nreturn { catalogProviderInfos };")();
const groupsFn = slice(client, "function catalogGroupsFromRemote", "\n    }\n") + "\n    }\n";
const { catalogGroupsFromRemote } = new Function(groupsFn + "\nreturn { catalogGroupsFromRemote };")();

test("catalogProviderInfos:listProviders 优先,configurable 补缺且按 id 去重", () => {
  const llm = {
    listProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }, { id: "workbuddy", name: "Workbuddy" }],
    listConfigurableProviders: () => [
      { provider: "openai-codex", displayName: "Codex duplicate" },
      { provider: "ac-all", displayName: "All catalog" },
      { provider: "", displayName: "ignored" },
    ],
  };
  assert.deepEqual(catalogProviderInfos(llm), [
    { id: "openai-codex", name: "OpenAI Codex" },
    { id: "workbuddy", name: "Workbuddy" },
    { id: "ac-all", name: "All catalog" },
  ]);
});

test("catalogProviderInfos:缺 listConfigurableProviders 时仍可用", () => {
  const llm = { listProviders: () => [{ id: "deepseek", name: "DeepSeek" }] };
  assert.deepEqual(catalogProviderInfos(llm), [{ id: "deepseek", name: "DeepSeek" }]);
});

test("catalogGroupsFromRemote:HTTP JSON 与 RemoteResult 都能抽出 groups", () => {
  const groups = [{ id: "workbuddy", name: "Workbuddy", models: [{ id: "wb-1", name: "WB 1" }] }];
  assert.equal(catalogGroupsFromRemote({ groups })[0].id, "workbuddy");
  assert.equal(catalogGroupsFromRemote({ ok: true, value: { groups } })[0].id, "workbuddy");
});

test("catalogGroupsFromRemote:RemoteResult 失败抛出宿主错误信息", () => {
  assert.throws(() => catalogGroupsFromRemote({ ok: false, error: { message: "catalog down" } }), /catalog down/);
});

test("线上强化入口不再调用 enhanceWithChildAgent", () => {
  const handle = slice(host, "async function handleRoute", "\n}\n");
  assert.ok(handle.includes("enhanceWithLlm"));
  assert.ok(!handle.includes("enhanceWithChildAgent"));
  assert.ok(handle.includes('const channel = "llm"'));
});

test("persona 不再要求 glob/grep/read", () => {
  const persona = slice(host, "function enhancerPersona", "\n}\n");
  assert.ok(persona.includes("你没有文件工具"));
  assert.ok(!persona.includes("用 glob/grep/read 等只读工具"));
});
test("设置卡片不读取 remote.session,只拉本插件 /models", () => {
  const load = slice(client, "const loadModels = () => {", "loadModels();");
  assert.ok(!load.includes("remote.session"));
  assert.ok(!load.includes("modelCatalog"));
  assert.ok(load.includes("MODELS_ENDPOINT"));
  assert.ok(!client.includes("remote.session"));
});
