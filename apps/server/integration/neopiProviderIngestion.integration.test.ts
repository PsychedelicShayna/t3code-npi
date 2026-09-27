import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";
import { makeNeoPiAdapter } from "../src/provider/Layers/NeoPiAdapter.ts";
import { makeNeoPiDiscoveryHub } from "../src/provider/neopi/NeoPiDiscovery.ts";
import type { NeoPiRuntimeInput } from "../src/provider/neopi/NeoPiSessionRuntime.ts";
import type {
  NeoPiResumeCursor,
  NeoPiRuntimeFrame,
  NeoPiRuntimeState,
  NeoPiSessionRuntimeShape,
} from "../src/provider/neopi/NeoPiRuntimeTypes.ts";

const provider = ProviderDriverKind.make("neopi");
const instanceId = ProviderInstanceId.make("neopi");
const firstThread = ThreadId.make("neopi-ingestion-first");
const otherThread = ThreadId.make("neopi-ingestion-other");
const createdAt = "2026-09-27T00:00:00.000Z";

/** Controlled native frames, but the adapter, ProviderService, ingestion and sqlite are real. */
const makeRuntime = (input: NeoPiRuntimeInput) =>
  Effect.gen(function* () {
    const frames = yield* Queue.unbounded<NeoPiRuntimeFrame>();
    const state = yield* SubscriptionRef.make<NeoPiRuntimeState>("stopped");
    const sessionDir = `${input.t3Home}/neopi/sessions/default/${input.threadId}`;
    const cursor = yield* SubscriptionRef.make<NeoPiResumeCursor>(
      input.cursor ?? {
        v: 1,
        sessionDir,
        sessionId: `native-${input.threadId}`,
        sessionFile: `${sessionDir}/session.jsonl`,
        turnBoundaries: [],
      },
    );
    return {
      threadId: input.threadId,
      state,
      cursor,
      capabilities: new Set(["v2"]),
      start: SubscriptionRef.set(state, "ready"),
      startTurn: (turn) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.set(state, "running");
          const previous = yield* SubscriptionRef.get(cursor);
          yield* SubscriptionRef.set(cursor, {
            ...previous,
            turnBoundaries: [
              ...previous.turnBoundaries,
              { turnId: turn.turnId, userEntryId: `native-user-${turn.turnId}` },
            ],
          });
          const text = `answer: ${turn.text}`;
          for (const frame of [
            { type: "agent_start", turnId: turn.turnId },
            {
              type: "message_start",
              message: { role: "assistant", content: [] },
              turnId: turn.turnId,
            },
            {
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: text },
              turnId: turn.turnId,
            },
            {
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text }] },
              turnId: turn.turnId,
            },
            ...(turn.text === "first"
              ? [
                  {
                    type: "tool_execution_start",
                    toolCallId: "tool-1",
                    toolName: "bash",
                    args: { command: "pwd" },
                    turnId: turn.turnId,
                  },
                  {
                    type: "tool_execution_end",
                    toolCallId: "tool-1",
                    toolName: "bash",
                    result: { content: [{ type: "text", text: "workspace" }] },
                    turnId: turn.turnId,
                  },
                ]
              : []),
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
      stop: SubscriptionRef.set(state, "stopped").pipe(Effect.andThen(Queue.shutdown(frames))),
      setRuntimeMode: () => Effect.void,
      onSessionIdentityMayHaveChanged: Effect.void,
      applyModelSelection: () => Effect.void,
    } satisfies NeoPiSessionRuntimeShape;
  });

it.live(
  "preserves NeoPi turns, tool activities and cursor across threads and session restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
          commandId: CommandId.make("neopi-project-create"),
          projectId: ProjectId.make("neopi-project"),
          title: "NeoPi project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: { instanceId, model: "neopi-current" },
          createdAt,
        });
        for (const [index, threadId] of [firstThread, otherThread].entries()) {
          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`neopi-thread-create-${index}`),
            threadId,
            projectId: ProjectId.make("neopi-project"),
            title: `NeoPi thread ${index}`,
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
        }
        yield* harness.providerService.sendTurn({ threadId: firstThread, input: "first" });
        yield* harness.providerService.sendTurn({ threadId: otherThread, input: "parallel" });
        yield* harness.waitForThread(
          firstThread,
          (thread) =>
            thread.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.text === "answer: first" &&
                !message.streaming,
            ) && thread.activities.some((activity) => activity.kind === "tool.completed"),
        );
        yield* harness.waitForThread(otherThread, (thread) =>
          thread.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.text === "answer: parallel" &&
              !message.streaming,
          ),
        );
        yield* harness.providerService.sendTurn({ threadId: firstThread, input: "second" });
        yield* harness.waitForThread(firstThread, (thread) =>
          thread.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.text === "answer: second" &&
              !message.streaming,
          ),
        );
        yield* harness.providerService.stopSession({ threadId: firstThread });
        yield* harness.providerService.startSession(firstThread, {
          threadId: firstThread,
          provider,
          providerInstanceId: instanceId,
          cwd: harness.workspaceDir,
          runtimeMode: "approval-required",
        });
        const resumed = (yield* adapter.listSessions()).find(
          (session) => session.threadId === firstThread,
        );
        assert.equal((resumed?.resumeCursor as NeoPiResumeCursor).turnBoundaries.length, 2);
        yield* harness.providerService.sendTurn({ threadId: firstThread, input: "after restart" });
        const first = yield* harness.waitForThread(
          firstThread,
          (thread) =>
            thread.messages.filter((message) => message.role === "assistant" && !message.streaming)
              .length === 3 && thread.session?.status === "ready",
        );
        const other = yield* harness.waitForThread(otherThread, (thread) =>
          thread.messages.some((message) => message.role === "assistant" && !message.streaming),
        );
        assert.deepEqual(
          first.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.text),
          ["answer: first", "answer: second", "answer: after restart"],
        );
        const assistantIds = [...first.messages, ...other.messages]
          .filter((message) => message.role === "assistant")
          .map((message) => message.id);
        assert.equal(new Set(assistantIds).size, 4);
        assert.equal(
          first.activities.filter((activity) => activity.kind === "tool.completed").length,
          1,
        );
        assert.equal(
          first.activities.filter((activity) => activity.kind === "tool.completed")[0]?.id !==
            undefined,
          true,
        );
        const finalSession = (yield* adapter.listSessions()).find(
          (session) => session.threadId === firstThread,
        );
        assert.equal((finalSession?.resumeCursor as NeoPiResumeCursor).turnBoundaries.length, 3);
        const newCwd = `${harness.workspaceDir}/moved`;
        yield* (yield* FileSystem.FileSystem).makeDirectory(newCwd, { recursive: true });
        yield* harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("neopi-move-worktree"),
          threadId: firstThread,
          worktreePath: newCwd,
        });
        yield* harness.engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("neopi-change-mode"),
          threadId: firstThread,
          runtimeMode: "auto",
          createdAt,
        });
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("neopi-restart-through-reactor"),
          threadId: firstThread,
          message: {
            messageId: MessageId.make("neopi-user-after-cwd-change"),
            role: "user",
            text: "cwd mode restart",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "auto",
          createdAt,
        });
        yield* harness.waitForThread(
          firstThread,
          (thread) =>
            thread.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.text === "answer: cwd mode restart" &&
                !message.streaming,
            ) && thread.session?.status === "ready",
        );
        const moved = (yield* adapter.listSessions()).find(
          (session) => session.threadId === firstThread,
        );
        assert.equal(moved?.cwd, newCwd);
        assert.equal(moved?.runtimeMode, "auto");
        assert.equal((moved?.resumeCursor as NeoPiResumeCursor).turnBoundaries.length, 4);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
