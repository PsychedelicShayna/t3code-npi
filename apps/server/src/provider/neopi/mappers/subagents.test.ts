import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vite-plus/test";

import { makeOrchestrationIntegrationHarness } from "../../../../integration/OrchestrationEngineHarness.integration.ts";
import { makeNeoPiAdapter } from "../../Layers/NeoPiAdapter.ts";
import { makeNeoPiDiscoveryHub } from "../NeoPiDiscovery.ts";
import type { NeoPiRuntimeInput } from "../NeoPiSessionRuntime.ts";
import type {
  NeoPiRuntimeFrame,
  NeoPiRuntimeState,
  NeoPiSessionRuntimeShape,
} from "../NeoPiRuntimeTypes.ts";
import { emptyCoreState, mapCoreFrame } from "./core.ts";
import type { MapCtx } from "./MapCtx.ts";
import { emptySubagentState, mapSubagentFrame } from "./subagents.ts";

function ctx(): MapCtx {
  let nextId = 0;
  return {
    provider: ProviderDriverKind.make("neopi"),
    providerInstanceId: ProviderInstanceId.make("neopi-test"),
    sessionKey: "session-1",
    threadId: ThreadId.make("thread-1"),
    turnId: TurnId.make("turn-1"),
    now: () => "2026-09-27T00:00:00.000Z",
    newEventId: () => `event-${++nextId}`,
  };
}

function assistant(text: string, usage?: object) {
  return {
    role: "assistant",
    timestamp: 100,
    provider: "openai",
    model: "example",
    content: [{ type: "text", text }],
    ...(usage ? { usage } : {}),
  };
}

function feed(frames: readonly unknown[]) {
  const context = ctx();
  let core = emptyCoreState();
  let subagents = emptySubagentState();
  const events: ProviderRuntimeEvent[] = [];
  for (const frame of frames) {
    const mappedCore = mapCoreFrame(context, frame, core);
    const mapped = mapSubagentFrame(context, frame, subagents);
    core = mappedCore.state;
    subagents = mapped.state;
    events.push(...mappedCore.events, ...mapped.events);
  }
  return { events, core, subagents };
}

function ofType(events: readonly ProviderRuntimeEvent[], type: ProviderRuntimeEvent["type"]) {
  return events.filter((event) => event.type === type);
}

const usage = (input: number, output: number, cacheRead = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  cost: { total: 0.01 },
});

describe("NeoPi subagent mapper", () => {
  it("maps lifecycle, two progress rows, and summed child usage onto task events", () => {
    const first = assistant("one", usage(10, 4, 1));
    const second = { ...assistant("two", usage(3, 5)), timestamp: 101 };
    const { events, core } = feed([
      { type: "agent_start" },
      {
        type: "subagent_lifecycle",
        payload: {
          id: "child-1",
          status: "started",
          agent: "scout",
          description: "Inspect the mapper",
          parentToolCallId: "tool-parent",
          index: 0,
        },
      },
      {
        type: "subagent_event",
        payload: {
          id: "child-1",
          event: { type: "message_end", message: first },
        },
      },
      {
        type: "subagent_event",
        payload: {
          id: "child-1",
          event: { type: "message_end", message: second },
        },
      },
      {
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "scout",
          task: "Inspect the mapper",
          progress: { id: "child-1", status: "running", recentOutput: ["reading core"] },
        },
      },
      {
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "scout",
          task: "Inspect the mapper",
          progress: { id: "child-1", status: "running", recentOutput: ["summing usage"] },
        },
      },
      {
        type: "subagent_lifecycle",
        payload: { id: "child-1", status: "completed", agent: "scout", index: 0 },
      },
      { type: "t3.turn.outcome", state: "completed" },
    ]);

    expect(ofType(events, "task.started").map((event) => event.payload)).toEqual([
      expect.objectContaining({
        taskId: "child-1",
        agentId: "child-1",
        description: "Inspect the mapper",
        parentToolUseId: "tool-parent",
        taskType: "subagent",
      }),
    ]);
    expect(ofType(events, "task.progress").map((event) => event.payload)).toEqual([
      expect.objectContaining({ taskId: "child-1", summary: "reading core", status: "running" }),
      expect.objectContaining({ taskId: "child-1", summary: "summing usage", status: "running" }),
    ]);
    expect(ofType(events, "task.completed").map((event) => event.payload)).toEqual([
      expect.objectContaining({
        taskId: "child-1",
        status: "completed",
        typedUsage: {
          totalTokens: 23,
          inputTokens: 14,
          outputTokens: 9,
          cachedInputTokens: 1,
        },
      }),
    ]);
    expect(ofType(events, "turn.completed")).toHaveLength(1);
    expect(core.hasSubagents).toBe(false);
    const completed = ofType(events, "turn.completed")[0];
    if (completed?.type !== "turn.completed") throw new Error("missing parent completion");
    expect(completed.payload.tokenUsage).toEqual({
      usageScope: "main_agent",
      hasSubagents: true,
      usageStatus: "unavailable",
    });
  });

  it("attributes child tools and text to the child and keeps them out of parent transcript events", () => {
    const { events } = feed([
      {
        type: "subagent_lifecycle",
        payload: {
          id: "child-1",
          status: "started",
          description: "Search",
          parentToolCallId: "tool-parent",
          agent: "scout",
          index: 0,
        },
      },
      {
        type: "subagent_event",
        payload: {
          id: "child-1",
          event: {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "CHILD-SECRET", contentIndex: 0 },
          },
        },
      },
      {
        type: "subagent_event",
        payload: {
          id: "child-1",
          event: {
            type: "tool_execution_start",
            toolCallId: "bash-1",
            toolName: "bash",
            args: { command: "pwd" },
          },
        },
      },
      {
        type: "subagent_event",
        payload: {
          id: "child-1",
          event: {
            type: "tool_execution_end",
            toolCallId: "bash-1",
            toolName: "bash",
            result: { content: [{ type: "text", text: "workspace" }] },
          },
        },
      },
      {
        type: "subagent_event",
        payload: { id: "child-1", event: { type: "agent_end", messages: [] } },
      },
    ]);

    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "content.delta" &&
          (event.payload.streamKind === "assistant_text" ||
            event.payload.streamKind === "reasoning_text"),
      ),
    ).toBe(false);
    expect(ofType(events, "task.progress").map((event) => event.payload)).toEqual([
      expect.objectContaining({
        taskId: "child-1",
        agentId: "child-1",
        summary: "CHILD-SECRET",
      }),
    ]);
    const tool = events.find(
      (event) => event.type === "item.completed" && event.payload.itemType === "command_execution",
    );
    expect(tool?.payload).toEqual(
      expect.objectContaining({ agentId: "child-1", parentToolUseId: "tool-parent" }),
    );
    expect(tool && "itemId" in tool ? tool.itemId : undefined).toContain("child-1");
  });

  it("starts a distinct task when a completed child id is reused", () => {
    const started = (id: string) => ({
      type: "subagent_lifecycle",
      payload: { id, status: "started", description: id, agent: "scout", index: 0 },
    });
    const { events } = feed([
      started("child-1"),
      { type: "subagent_lifecycle", payload: { id: "child-1", status: "completed", index: 0 } },
      started("child-1"),
    ]);
    expect(ofType(events, "task.started").map((event) => event.payload.taskId)).toEqual([
      "child-1",
      "child-1#2",
    ]);
  });
});

effectIt.live("child subagent text does not enter the parent message through ingestion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("neopi");
      const instanceId = ProviderInstanceId.make("neopi");
      const threadId = ThreadId.make("neopi-subagent-ingestion");
      const createdAt = "2026-09-27T00:00:00.000Z";
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const makeRuntime = (input: NeoPiRuntimeInput) =>
        Effect.gen(function* () {
          const frames = yield* Queue.unbounded<NeoPiRuntimeFrame>();
          const state = yield* SubscriptionRef.make<NeoPiRuntimeState>("stopped");
          const cursor = yield* SubscriptionRef.make({
            v: 1 as const,
            sessionDir: "/tmp",
            sessionId: "native",
            sessionFile: "/tmp/session.jsonl",
            turnBoundaries: [],
          });
          return {
            threadId: input.threadId,
            state,
            cursor,
            capabilities: new Set(["v2"]),
            start: SubscriptionRef.set(state, "ready"),
            startTurn: (turn) =>
              Effect.gen(function* () {
                yield* SubscriptionRef.set(state, "running");
                const childUsage = { input: 8, output: 2, cacheRead: 0, cacheWrite: 0 };
                for (const frame of [
                  { type: "agent_start", turnId: turn.turnId },
                  {
                    type: "message_update",
                    assistantMessageEvent: { type: "text_delta", delta: "parent answer" },
                    turnId: turn.turnId,
                  },
                  {
                    type: "message_end",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "parent answer" }],
                    },
                    turnId: turn.turnId,
                  },
                  {
                    type: "subagent_lifecycle",
                    payload: {
                      id: "child-1",
                      status: "started",
                      description: "Look around",
                      parentToolCallId: "tool-parent",
                      agent: "scout",
                      index: 0,
                    },
                    turnId: turn.turnId,
                  },
                  {
                    type: "subagent_event",
                    payload: {
                      id: "child-1",
                      event: {
                        type: "message_update",
                        assistantMessageEvent: {
                          type: "text_delta",
                          delta: "CHILD-SECRET",
                          contentIndex: 0,
                        },
                      },
                    },
                    turnId: turn.turnId,
                  },
                  {
                    type: "subagent_event",
                    payload: {
                      id: "child-1",
                      event: {
                        type: "message_end",
                        message: {
                          role: "assistant",
                          content: [{ type: "text", text: "CHILD-SECRET" }],
                          usage: childUsage,
                        },
                      },
                    },
                    turnId: turn.turnId,
                  },
                  {
                    type: "subagent_event",
                    payload: {
                      id: "child-1",
                      event: { type: "agent_end", messages: [] },
                    },
                    turnId: turn.turnId,
                  },
                  {
                    type: "subagent_lifecycle",
                    payload: { id: "child-1", status: "completed", agent: "scout", index: 0 },
                    turnId: turn.turnId,
                  },
                  { type: "t3.turn.outcome", state: "completed", turnId: turn.turnId },
                ])
                  yield* Queue.offer(frames, frame);
                yield* SubscriptionRef.set(state, "ready");
                return { turnId: turn.turnId };
              }),
            steer: () => Effect.void,
            interrupt: SubscriptionRef.set(state, "ready"),
            compact: () => Effect.void,
            respondUi: () => Effect.void,
            writeFrame: () => Effect.void,
            request: () => Effect.succeed({ messages: [] }),
            frames: Stream.fromQueue(frames),
            restart: () => Effect.void,
            stop: SubscriptionRef.set(state, "stopped").pipe(
              Effect.andThen(Queue.shutdown(frames)),
            ),
            setRuntimeMode: () => Effect.void,
            onSessionIdentityMayHaveChanged: Effect.void,
            applyModelSelection: () => Effect.void,
          } satisfies NeoPiSessionRuntimeShape;
        });
      const adapter = yield* makeNeoPiAdapter({
        settings: {
          enabled: true,
          binaryPath: "npi",
          profile: "",
          launchArgs: "",
          customModels: [],
        },
        instanceId,
        binary: "npi",
        cwd: "/tmp",
        t3Home: "/tmp",
        attachmentsDir: "/tmp",
        environment: {},
        spawn: spawner.spawn,
        discovery: yield* makeNeoPiDiscoveryHub(),
        makeRuntime,
      });
      const harness = yield* makeOrchestrationIntegrationHarness({ provider, adapter });
      yield* Effect.addFinalizer(() => harness.dispose);
      yield* harness.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("neopi-subagent-project"),
        projectId: ProjectId.make("neopi-subagent-project"),
        title: "NeoPi subagents",
        workspaceRoot: harness.workspaceDir,
        defaultModelSelection: { instanceId, model: "neopi-current" },
        createdAt,
      });
      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("neopi-subagent-thread"),
        threadId,
        projectId: ProjectId.make("neopi-subagent-project"),
        title: "Subagent thread",
        modelSelection: { instanceId, model: "neopi-current" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: harness.workspaceDir,
        createdAt,
      });
      yield* harness.providerService.startSession(threadId, {
        threadId,
        provider,
        providerInstanceId: instanceId,
        cwd: harness.workspaceDir,
        runtimeMode: "approval-required",
      });
      yield* harness.providerService.sendTurn({ threadId, input: "delegate" });
      const thread = yield* harness.waitForThread(
        threadId,
        (entry) =>
          entry.session?.status === "ready" &&
          entry.messages.some(
            (message) => message.role === "assistant" && message.text === "parent answer",
          ) &&
          entry.activities.some((activity) => activity.kind === "task.completed"),
      );
      const assistantText = thread.messages
        .filter((message) => message.role === "assistant" || message.role === "reasoning")
        .map((message) => message.text)
        .join("\n");
      assert.equal(assistantText.includes("CHILD-SECRET"), false);
      assert.equal(assistantText, "parent answer");
      const completed = thread.activities.find((activity) => activity.kind === "task.completed");
      const payload =
        completed?.payload && typeof completed.payload === "object"
          ? (completed.payload as { typedUsage?: { inputTokens?: number }; agentId?: string })
          : undefined;
      assert.equal(payload?.agentId, "child-1");
      assert.equal(payload?.typedUsage?.inputTokens, 8);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
