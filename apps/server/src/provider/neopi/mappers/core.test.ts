import { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { coreTurnTokenUsage, emptyCoreState, mapCoreFrame } from "./core.ts";
import type { MapCtx } from "./MapCtx.ts";
import { scopedItemId } from "./MapCtx.ts";

function harness(child = false) {
  let nextId = 0;
  const ctx: MapCtx = {
    provider: ProviderDriverKind.make("neopi"),
    providerInstanceId: ProviderInstanceId.make("neopi-test"),
    threadId: ThreadId.make("thread-test"),
    turnId: TurnId.make("turn-test"),
    ...(child ? { agentId: "child-1", parentToolUseId: "tool-1" } : {}),
    now: () => "2026-09-27T00:00:00.000Z",
    newEventId: () => `event-${++nextId}`,
  };
  let state = emptyCoreState();
  const events: ReturnType<typeof mapCoreFrame>["events"] = [];
  return {
    events,
    feed(frame: unknown) {
      const result = mapCoreFrame(ctx, frame, state);
      state = result.state;
      events.push(...result.events);
      return result.events;
    },
    usage: () => coreTurnTokenUsage(state),
  };
}

const assistant = (text: string, usage?: object) => ({
  role: "assistant",
  timestamp: 123,
  provider: "openai",
  model: "example",
  content: [{ type: "text", text }],
  ...(usage ? { usage } : {}),
});

function payloads(events: ReturnType<typeof harness>["events"], type: string) {
  return events.filter((event) => event.type === type).map((event) => event.payload);
}

const itemId = (nativeId: string) =>
  scopedItemId(
    {
      provider: ProviderDriverKind.make("neopi"),
      providerInstanceId: ProviderInstanceId.make("neopi-test"),
      threadId: ThreadId.make("thread-test"),
      turnId: TurnId.make("turn-test"),
      now: () => "",
      newEventId: () => "",
    },
    nativeId,
  );

describe("NeoPi core mapper", () => {
  it("keeps interleaved reasoning and assistant text items distinct with ordered deltas and completions", () => {
    const h = harness();
    h.feed({ type: "agent_start" });
    h.feed({ type: "message_start", message: assistant("") });
    for (const [type, contentIndex, delta] of [
      ["thinking_delta", 0, "first "],
      ["text_delta", 1, "hello "],
      ["thinking_delta", 0, "thought"],
      ["text_delta", 1, "world"],
    ] as const) {
      h.feed({ type: "message_update", assistantMessageEvent: { type, contentIndex, delta } });
    }
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "hello world" },
    });
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "first thought" },
    });
    h.feed({ type: "message_end", message: assistant("hello world") });
    const deltas = h.events.filter((event) => event.type === "content.delta");
    expect(deltas.map((event) => [event.itemId, event.payload])).toEqual([
      [
        itemId("neopi:m1:thinking:0"),
        { streamKind: "reasoning_text", delta: "first ", contentIndex: 0 },
      ],
      [
        itemId("neopi:m1:text:1"),
        { streamKind: "assistant_text", delta: "hello ", contentIndex: 1 },
      ],
      [
        itemId("neopi:m1:thinking:0"),
        { streamKind: "reasoning_text", delta: "thought", contentIndex: 0 },
      ],
      [
        itemId("neopi:m1:text:1"),
        { streamKind: "assistant_text", delta: "world", contentIndex: 1 },
      ],
    ]);
    const starts = h.events.filter((event) => event.type === "item.started");
    const completed = h.events.filter((event) => event.type === "item.completed");
    expect(starts.map((event) => event.itemId)).toEqual([
      itemId("neopi:m1:thinking:0"),
      itemId("neopi:m1:text:1"),
    ]);
    expect(completed.map((event) => [event.itemId, event.payload.detail])).toEqual([
      [itemId("neopi:m1:thinking:0"), "first thought"],
      [itemId("neopi:m1:text:1"), "hello world"],
    ]);
    expect(h.events.every((event) => event.raw?.source === "neopi.rpc")).toBe(true);
  });

  it("sums typed usage once per assistant message, counts cache, and distinguishes partial turns", () => {
    const h = harness();
    const usage = {
      input: 100,
      cacheRead: 900,
      cacheWrite: 50,
      output: 40,
      reasoningTokens: 10,
      cost: { total: 0.023 },
    };
    const first = assistant("first", usage);
    const second = { ...assistant("second"), timestamp: 124 };
    h.feed({ type: "agent_start" });
    h.feed({ type: "message_start", message: first });
    h.feed({ type: "message_end", message: first });
    h.feed({ type: "message_start", message: second });
    h.feed({ type: "message_end", message: second });
    h.feed({ type: "subagent_lifecycle", id: "sub-1", status: "started" });
    // Both messages are repeated by agent_end; signatures and fallback ordinals must never re-add first.
    h.feed({ type: "agent_end", messages: [first, second] });
    expect(h.usage()).toEqual({
      usageScope: "main_agent",
      hasSubagents: true,
      usageStatus: "partial",
      inputTokens: 1050,
      cachedInputTokens: 900,
      cacheCreationTokens: 50,
      outputTokens: 40,
      reasoningTokens: 10,
    });
    expect(
      payloads(h.feed({ type: "t3.turn.outcome", state: "completed" }), "turn.completed"),
    ).toEqual([
      {
        state: "completed",
        tokenUsage: {
          usageScope: "main_agent",
          hasSubagents: true,
          usageStatus: "partial",
          inputTokens: 1050,
          cachedInputTokens: 900,
          cacheCreationTokens: 50,
          outputTokens: 40,
          reasoningTokens: 10,
        },
        totalCostUsd: 0.023,
      },
    ]);
  });

  it("pairs compacted suffix messages and a message_end arriving after turn_end", () => {
    const h = harness();
    h.feed({ type: "agent_start" });
    const first = assistant("one", { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 });
    const second = { ...assistant("two"), timestamp: 124 };
    h.feed({ type: "message_start", message: first });
    h.feed({ type: "message_end", message: first });
    h.feed({ type: "message_start", message: second });
    h.feed({ type: "turn_end" });
    h.feed({ type: "message_end", message: second });
    h.feed({ type: "agent_end", messages: [second] });
    expect(h.usage()).toMatchObject({ inputTokens: 3, outputTokens: 2, usageStatus: "partial" });
  });

  it("reports context occupancy from contextUsage instead of lifetime token totals", () => {
    const h = harness();
    h.feed({ type: "agent_start" });
    h.feed({
      type: "message_end",
      message: assistant("hi", { input: 999, output: 777, cacheRead: 10 }),
    });
    expect(
      payloads(
        h.feed({
          type: "t3.state",
          state: {
            model: { provider: "openai", id: "gpt" },
            contextUsage: { tokens: 742, contextWindow: 200000, percent: 0.37 },
            tokenUsage: { input: 99999, output: 77777 },
          },
        }),
        "thread.token-usage.updated",
      ),
    ).toEqual([{ usage: { usedTokens: 742, maxTokens: 200000 } }]);
    expect(
      payloads(
        h.feed({ type: "t3.state", state: { contextUsage: { tokens: 0, contextWindow: 0 } } }),
        "thread.token-usage.updated",
      ),
    ).toEqual([{ usage: { usedTokens: 0 } }]);
  });

  it("warns on retries without ending the turn; only the injected outcome decides failure", () => {
    const h = harness();
    h.feed({ type: "agent_start" });
    h.feed({ type: "auto_retry_start", attempt: 1, errorMessage: "temporary" });
    h.feed({ type: "auto_retry_end", success: false, finalError: "retry exhausted" });
    h.feed({ type: "agent_end", messages: [] });
    expect(payloads(h.events, "runtime.warning")).toHaveLength(2);
    expect(payloads(h.events, "turn.completed")).toHaveLength(0);
    expect(
      payloads(
        h.feed({
          type: "t3.turn.outcome",
          state: "failed",
          errorMessage: "provider rejected request",
        }),
        "turn.completed",
      ),
    ).toMatchObject([
      {
        state: "failed",
        errorMessage: "provider rejected request",
        tokenUsage: { usageStatus: "unavailable" },
      },
    ]);
  });

  it("refreshes metadata, announces reroutes, and translates notices and extension errors", () => {
    const h = harness();
    h.feed({
      type: "config_update",
      model: { provider: "openai", id: "gpt-5" },
      thinkingLevel: "high",
    });
    expect(payloads(h.feed({ type: "agent_start" }), "turn.started")).toEqual([
      { model: "openai/gpt-5", effort: "high" },
    ]);
    h.feed({ type: "thinking_level_changed", thinkingLevel: "medium" });
    expect(payloads(h.events, "thread.metadata.updated")).toEqual([
      { metadata: { model: "openai/gpt-5", thinkingLevel: "high" } },
      { metadata: { model: "openai/gpt-5", thinkingLevel: "medium" } },
    ]);
    h.feed({
      type: "retry_fallback_applied",
      from: "openai/gpt-5",
      to: "openai/gpt-4",
      role: "default",
    });
    expect(payloads(h.events, "model.rerouted")).toEqual([
      { fromModel: "openai/gpt-5", toModel: "openai/gpt-4", reason: "Retry fallback (default)" },
    ]);
    h.feed({ type: "notice", level: "warning", message: "heads up" });
    h.feed({ type: "notice", level: "error", message: "bad" });
    h.feed({
      type: "extension_error",
      extensionPath: "/x",
      event: "session_start",
      error: "broken extension",
    });
    expect(payloads(h.events, "runtime.warning")).toMatchObject([
      { message: "heads up" },
      { message: "broken extension" },
    ]);
    expect(payloads(h.events, "runtime.error")).toMatchObject([
      { message: "bad", class: "provider_error" },
    ]);
  });

  it("completes compaction once and never announces aborted or skipped compaction", () => {
    const h = harness();
    h.feed({ type: "auto_compaction_start" });
    h.feed({ type: "auto_compaction_end", result: { tokensBefore: 8100, summary: "summary" } });
    h.feed({ type: "t3.compaction", beforeTokens: 8100, afterTokens: 3200, summary: "summary" });
    expect(payloads(h.events, "thread.state.changed")).toEqual([
      { state: "compacted", beforeTokens: 8100, detail: "summary" },
      { state: "compacted", beforeTokens: 8100, afterTokens: 3200, detail: "summary" },
    ]);
    h.feed({ type: "auto_compaction_start" });
    h.feed({ type: "auto_compaction_end", aborted: true, errorMessage: "cancelled" });
    h.feed({ type: "auto_compaction_start" });
    h.feed({ type: "auto_compaction_end", skipped: true });
    expect(payloads(h.events, "thread.state.changed")).toHaveLength(2);
    expect(payloads(h.events, "item.completed")).toMatchObject([
      { itemType: "context_compaction", status: "completed" },
      { itemType: "context_compaction", status: "failed" },
      { itemType: "context_compaction", status: "declined" },
    ]);
  });

  it("keeps one turn and sums both phases when a nonterminal agent run continues", () => {
    const h = harness();
    expect(
      h.feed({ type: "agent_start" }).filter((event) => event.type === "turn.started"),
    ).toHaveLength(1);
    h.feed({ type: "message_start", message: assistant("") });
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "first" },
    });
    h.feed({ type: "message_end", message: assistant("first", { input: 8, output: 3 }) });
    h.feed({ type: "agent_end", isTerminal: false });
    expect(
      h.feed({ type: "agent_start" }).filter((event) => event.type === "turn.started"),
    ).toHaveLength(0);
    h.feed({ type: "message_start", message: assistant("") });
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "second" },
    });
    h.feed({ type: "message_end", message: assistant("second", { input: 12, output: 4 }) });
    h.feed({ type: "agent_end", isTerminal: true });
    h.feed({ type: "t3.turn.outcome", state: "completed" });
    expect(payloads(h.events, "turn.completed")).toMatchObject([
      {
        state: "completed",
        tokenUsage: { usageStatus: "complete", inputTokens: 20, outputTokens: 7 },
      },
    ]);
    const started = h.events.filter((event) => event.type === "item.started");
    expect(new Set(started.map((event) => event.itemId)).size).toBe(2);
  });

  it("attributes nested content to the child without producing parent turn events", () => {
    const h = harness(true);
    h.feed({ type: "agent_start" });
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "child" },
    });
    h.feed({ type: "message_end", message: assistant("child", { input: 2, output: 1 }) });
    h.feed({ type: "agent_end", messages: [] });
    h.feed({ type: "t3.turn.outcome", state: "completed" });
    expect(payloads(h.events, "turn.started")).toHaveLength(0);
    expect(payloads(h.events, "turn.completed")).toHaveLength(0);
    expect(payloads(h.events, "item.completed")).toMatchObject([
      { agentId: "child-1", parentToolUseId: "tool-1" },
    ]);
  });
});
