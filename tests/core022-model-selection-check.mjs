// Offline 0.2.2 regression: exercise the shipped runEnhanceChild with a scoped
// registry double. No plugin import, host service, adapter, or LLM call occurs.
// node tests/core022-model-selection-check.mjs [absolute-or-relative index.js ...]
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const defaults = [
  new URL("../src/index.js", import.meta.url),
  new URL("../lib/index.js", import.meta.url),
  new URL("../../dsh-sync/home/vendor/dsh-external__dsh-prompt-enhancer-0.1.3-dsh020.1/lib/index.js", import.meta.url),
].map(fileURLToPath).filter((path) => existsSync(path));
const targets = process.argv.slice(2).length ? process.argv.slice(2).map(p => resolve(p)) : defaults;

function extract(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, marker);
  const end = source.indexOf(String.fromCharCode(10) + "}" + String.fromCharCode(10), start);
  assert.ok(end >= 0, marker + " closing brace");
  return source.slice(start, end + 3);
}

for (const target of targets) {
  const source = readFileSync(target, "utf8").split(String.fromCharCode(13)).join("");
  const waitForTurn = new Function(extract(source, "async function waitForTurn") + ";return waitForTurn;")();
  const run = new Function(
    "descriptorVersion", "READONLY_TOOLS", "diagLog", "userMessage", "waitForTurn",
    "lastAssistantText", "childOutputTruncated", "CHILD_TIMEOUT_MS", "truncateJson",
    extract(source, "function installDescriptorAppend") +
    extract(source, "function sessionEvents") +
    extract(source, "async function runEnhanceChild") + ";return runEnhanceChild;",
  )(3, ["glob", "grep", "read"], () => {}, text => ({ content: text }), waitForTurn,
    events => events.find(e => e.type === "assistant/message")?.data.text ?? "",
    () => false, 1000, value => JSON.stringify(value));
  const route = { provider: "parent", model: "parent-model", reasoningEffort: "high", maxTokens: 512 };
  const cases = [
    ["inherit explicit effort", route, undefined, "high"],
    ["inherit unset effort", { provider: "parent", model: "parent-model" }, undefined, undefined],
    ["dedicated explicit effort", route, { provider: "child", model: "child-model", reasoningEffort: "low" }, "low"],
    ["dedicated adapter default", route, { provider: "child", model: "child-model" }, undefined],
    ["dedicated undefined effort", route, { provider: "child", model: "child-model", reasoningEffort: undefined }, undefined],
    ["dedicated empty effort", route, { provider: "child", model: "child-model", reasoningEffort: "" }, undefined],
    ["same route dedicated effort", route, { provider: "parent", model: "parent-model", reasoningEffort: "low" }, "low"],
    ["same route dedicated unset", route, { provider: "parent", model: "parent-model" }, undefined],
  ];
  for (const [name, parentRoute, modelCfg, expectedEffort] of cases) {
    for (const joinPreset of [true, false]) {
      test(target + " / " + name + " / joinPreset=" + joinPreset, async () => {
        let options, disposed = 0, composed = 0, restricted = 0, persona;
        const workspaceCalls = [];
        const listeners = new Map();
        const events = [];
        const childCtx = {
          on(name, handler) { listeners.set(name, handler); },
          get(name) { assert.equal(name, "agentPresets"); return { composeFrom() { composed++; } }; },
          systemPrompt: { section(value) { persona = value; } },
          tools: { restrict(value) { assert.deepEqual(value, { allow: ["glob", "grep", "read"] }); restricted++; } },
        };
        const agent = {
          session: { header: { cwd: "D:/repo" }, append(type, data) { events.push({ type, data }); }, snapshotEvents() { return events; } },
          activityDone: Promise.resolve(),
          followup() {
            this.activityDone = (async () => {
              // Actual 0.2.2 prepareRequest contract (agent-loop/lib/index.js:990-1001):
              // selection is fixed before agent/request; all three fields must agree.
              const selection = { ...options.agentOptions };
              let proposal = Object.freeze({ ...selection });
              const handler = listeners.get("agent/request");
              if (handler) proposal = await handler({ agent: this }, async () => proposal);
              assert.equal(proposal.provider, selection.provider, "agent/request changed fixed provider");
              assert.equal(proposal.model, selection.model, "agent/request changed fixed model");
              assert.equal(proposal.reasoningEffort, selection.reasoningEffort, "agent/request changed fixed reasoning effort");
              events.push({ type: "assistant/message", data: { text: "offline result" } });
            })();
          },
        };
        const ctx = {
          logger: { warn(message) { assert.fail(message); } },
          agents: { async create(value) { options = value; value.setup(childCtx, agent); return { agent, async dispose() { disposed++; } }; } },
          workspaceRegistry: { list() { return [{ sessionIds: ["parent-session"], attachSession(id) { workspaceCalls.push(["attach", id]); }, detachSession(id) { workspaceCalls.push(["detach", id]); } }]; } },
        };
        const result = await run(ctx, { ctx: {}, session: { header: { delegationDepth: 2 } } }, parentRoute,
          "D:/repo", "draft", "parent-session", undefined, modelCfg, joinPreset, "persona");
        const expected = {
          provider: modelCfg?.provider ?? parentRoute.provider,
          model: modelCfg?.model ?? parentRoute.model,
          ...(expectedEffort !== undefined ? { reasoningEffort: expectedEffort } : {}),
          ...(parentRoute.maxTokens !== undefined ? { maxTokens: parentRoute.maxTokens } : {}),
        };
        assert.deepEqual(options.agentOptions, expected, "complete model selection must precede step preparation");
        assert.equal(listeners.has("agent/request"), false, "do not register a late model override");
        assert.deepEqual(result, { text: "offline result", truncated: false });
        assert.deepEqual(options.meta, { cwd: "D:/repo", parentSession: "parent-session", origin: "subagent", delegationDepth: 3 });
        assert.equal(events.filter(e => e.type === "subagent/descriptor").length, 1);
        assert.equal(composed, Number(joinPreset));
        assert.equal(restricted, Number(joinPreset));
        assert.equal(persona.text, "persona");
        assert.equal(disposed, 1);
        assert.deepEqual(workspaceCalls, [["attach", options.sessionId], ["detach", options.sessionId]]);
      });
    }
  }
  for (const abort of [false, true]) {
    test(target + " / " + (abort ? "client cancellation" : "timeout") + " records a valid hook cause", async () => {
      let cause;
      const agent = { activityDone: new Promise(() => {}), cancel(value) { cause = value; } };
      const controller = new AbortController();
      const waiting = waitForTurn(agent, abort ? 1000 : 5, abort ? controller.signal : undefined, "强化子会话");
      if (abort) controller.abort("offline cancellation");
      await assert.rejects(waiting, error => error.fatal === true);
      assert.deepEqual(cause, { kind: "hook", reason: "强化子会话中止: " + (abort ? "客户端取消" : "超时(5ms)") });
    });
  }
}
