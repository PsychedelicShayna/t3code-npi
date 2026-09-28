import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type NeoPiSettings,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import { EnvironmentId } from "@t3tools/contracts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { makeNeoPiHostToolBridge } from "../neopi/NeoPiHostToolBridge.ts";
import type { NeoPiRuntimeInput } from "../neopi/NeoPiSessionRuntime.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeNeoPiDiscoveryHub } from "../neopi/NeoPiDiscovery.ts";
import type {
  NeoPiResumeCursor,
  NeoPiRuntimeFrame,
  NeoPiRuntimeState,
  NeoPiSessionRuntimeShape,
} from "../neopi/NeoPiRuntimeTypes.ts";
import { makeNeoPiAdapter } from "./NeoPiAdapter.ts";

const settings: NeoPiSettings = {
  enabled: true,
  binaryPath: "npi",
  profile: "",
  launchArgs: "",
  customModels: [],
};
const threadId = ThreadId.make("neopi-adapter-test");
const instanceId = ProviderInstanceId.make("neopi-test");

it.live("streams a turn, steers the same turn, routes UI responses, and stops its sessions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "neopi-adapter-test-" });
      const hub = yield* makeNeoPiDiscoveryHub();
      const frames = yield* Queue.unbounded<NeoPiRuntimeFrame>();
      const state = yield* SubscriptionRef.make<NeoPiRuntimeState>("stopped");
      const cursor = yield* SubscriptionRef.make<NeoPiResumeCursor>({
        v: 1 as const,
        sessionId: "test-session",
        sessionFile: `${home}/neopi/sessions/default/neopi-adapter-test/session.jsonl`,
        sessionDir: `${home}/neopi/sessions/default/neopi-adapter-test`,
        turnBoundaries: [],
      });
      const steers: string[] = [];
      const replies: unknown[] = [];
      let stopCount = 0;
      const runtime: NeoPiSessionRuntimeShape = {
        threadId,
        state,
        cursor,
        capabilities: new Set(["v2"]),
        start: SubscriptionRef.set(state, "ready"),
        startTurn: (input) =>
          SubscriptionRef.set(state, "running").pipe(Effect.as({ turnId: input.turnId })),
        steer: (input) =>
          Effect.sync(() => {
            steers.push(input.text);
          }),
        interrupt: SubscriptionRef.set(state, "ready"),
        compact: () => Effect.void,
        resolvePlanProposal: () => Effect.void,
        respondUi: (reply) =>
          Effect.sync(() => {
            replies.push(reply);
          }),
        writeFrame: (frame) =>
          Effect.sync(() => {
            replies.push(frame);
          }),
        request: (cmd) => Effect.succeed(cmd.type === "get_messages_page" ? { messages: [] } : {}),
        frames: Stream.fromQueue(frames),
        restart: () => Effect.void,
        stop: Effect.sync(() => {
          stopCount++;
        }),
        setRuntimeMode: () => Effect.void,
        onSessionIdentityMayHaveChanged: Effect.void,
        applyModelSelection: () => Effect.void,
      };
      const adapter = yield* makeNeoPiAdapter({
        settings,
        instanceId,
        binary: "npi",
        cwd: home,
        t3Home: home,
        attachmentsDir: home,
        environment: {},
        spawn: spawner.spawn,
        discovery: hub,
        makeRuntime: () => Effect.succeed(runtime),
      });
      const observed: ProviderRuntimeEvent[] = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          observed.push(event);
        }),
      ).pipe(Effect.forkScoped);
      const invalid = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("neopi"),
          providerInstanceId: instanceId,
          cwd: home,
          runtimeMode: "auto",
          resumeCursor: {
            v: 1,
            sessionId: "s",
            sessionFile: "/tmp/x",
            sessionDir: "/tmp",
            turnBoundaries: [{ turnId: 1 }],
          },
        })
        .pipe(Effect.flip);
      assert.match(invalid.message, /Invalid NeoPi\/OMP resume cursor/);
      assert.equal(yield* adapter.hasSession(threadId), false);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("neopi"),
        providerInstanceId: instanceId,
        cwd: home,
        runtimeMode: "auto",
      });
      const first = yield* adapter.sendTurn({ threadId, input: "say hi" });
      const second = yield* adapter.sendTurn({ threadId, input: "one more thing" });
      assert.equal(second.turnId, first.turnId);
      assert.deepEqual(steers, ["one more thing"]);
      yield* Queue.offer(frames, { type: "agent_start", turnId: first.turnId });
      yield* Queue.offer(frames, {
        type: "message_start",
        messageId: "m1",
        message: { role: "assistant", content: [] },
        turnId: first.turnId,
      });
      yield* Queue.offer(frames, {
        type: "message_update",
        messageId: "m1",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
        turnId: first.turnId,
      });
      yield* Queue.offer(frames, {
        type: "message_end",
        messageId: "m1",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        turnId: first.turnId,
      });
      yield* Queue.offer(frames, {
        type: "t3.turn.outcome",
        state: "completed",
        turnId: first.turnId,
      });
      yield* Queue.offer(frames, {
        type: "extension_ui_request",
        id: "ui-1",
        method: "select",
        title: "Allow tool: bash",
        options: ["Approve", "Deny"],
      });
      for (
        let attempt = 0;
        attempt < 100 && !observed.some((event) => event.type === "request.opened");
        attempt++
      )
        yield* Effect.sleep("10 millis");
      const opened = observed.find((event) => event.type === "request.opened");
      assert.ok(opened);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "accept",
      );
      for (
        let attempt = 0;
        attempt < 100 && !observed.some((event) => event.type === "request.resolved");
        attempt++
      )
        yield* Effect.sleep("10 millis");
      assert.deepEqual(replies, [{ id: "ui-1", value: "Approve" }]);
      assert.ok(
        observed.some(
          (event) =>
            event.type === "content.delta" && (event.payload as { delta?: string }).delta === "hi",
        ),
      );
      assert.ok(
        observed.some(
          (event) =>
            event.type === "turn.completed" &&
            (event.payload as { state?: string }).state === "completed",
        ),
      );
      assert.ok(observed.some((event) => event.type === "request.resolved"));
      assert.deepEqual(
        (yield* adapter.listSessions()).map((session) => session.resumeCursor),
        [yield* SubscriptionRef.get(cursor)],
      );
      yield* SubscriptionRef.set(state, "running");
      const busy = yield* adapter.readThread(threadId).pipe(Effect.flip);
      assert.match(busy.message, /session_busy/);
      yield* adapter.stopAll();
      assert.equal(stopCount, 1);
      assert.equal(yield* adapter.hasSession(threadId), false);
      const secondFrames = yield* Queue.unbounded<NeoPiRuntimeFrame>();
      const recreated = yield* makeNeoPiAdapter({
        settings,
        instanceId,
        binary: "npi",
        cwd: home,
        t3Home: home,
        attachmentsDir: home,
        environment: {},
        spawn: spawner.spawn,
        discovery: hub,
        makeRuntime: () => Effect.succeed({ ...runtime, frames: Stream.fromQueue(secondFrames) }),
      });
      const afterRestart: ProviderRuntimeEvent[] = [];
      yield* Stream.runForEach(recreated.streamEvents, (event) =>
        Effect.sync(() => {
          afterRestart.push(event);
        }),
      ).pipe(Effect.forkScoped);
      yield* recreated.startSession({
        threadId,
        provider: ProviderDriverKind.make("neopi"),
        providerInstanceId: instanceId,
        cwd: home,
        runtimeMode: "auto",
      });
      yield* Queue.offer(secondFrames, { type: "notice", level: "warning", message: "recreated" });
      for (let attempt = 0; attempt < 100 && afterRestart.length === 0; attempt++)
        yield* Effect.sleep("10 millis");
      assert.equal(afterRestart[0]?.type, "runtime.warning");
      assert.ok(observed.length > 0);
      assert.notEqual(afterRestart[0]?.eventId, observed[0]?.eventId);
      yield* recreated.stopAll();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

for (const capable of [false, true])
  it.live(`${capable ? "uses" : "does not use"} gated mode, proposal, and usage RPC features`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "neopi-gated-adapter-" });
        const hub = yield* makeNeoPiDiscoveryHub();
        const frames = yield* Queue.unbounded<NeoPiRuntimeFrame>();
        const state = yield* SubscriptionRef.make<NeoPiRuntimeState>("stopped");
        const cursor = yield* SubscriptionRef.make<NeoPiResumeCursor>({
          v: 1,
          sessionId: "gated-session",
          sessionFile: `${home}/session.jsonl`,
          sessionDir: home,
          turnBoundaries: [],
        });
        const requests: Array<{
          readonly type: string;
          readonly mode?: unknown;
          readonly provider?: unknown;
          readonly redact?: unknown;
        }> = [];
        const writes: unknown[] = [];
        let proposalId = "proposal-1";
        const turns: string[] = [];
        const capabilities = capable ? new Set(["v2", "set_mode", "get_usage"]) : new Set(["v2"]);
        const runtime: NeoPiSessionRuntimeShape = {
          threadId,
          state,
          cursor,
          capabilities,
          start: SubscriptionRef.set(state, "ready"),
          startTurn: (input) =>
            Effect.sync(() => {
              turns.push(input.text);
            }).pipe(
              Effect.andThen(SubscriptionRef.set(state, "running")),
              Effect.as({ turnId: input.turnId }),
            ),
          steer: () => Effect.void,
          interrupt: SubscriptionRef.set(state, "ready"),
          compact: () => Effect.void,
          resolvePlanProposal: (response, continuation) =>
            Effect.gen(function* () {
              writes.push({ type: "plan_proposal_response", id: proposalId, ...response });
              if (continuation) yield* SubscriptionRef.set(state, "running");
            }),
          respondUi: () => Effect.void,
          writeFrame: (frame) =>
            Effect.sync(() => {
              writes.push(frame);
            }),
          request: (command) =>
            Effect.sync(() => {
              requests.push(command);
              if (command.type === "get_state") return { mode: "default" };
              if (command.type === "get_usage") return { provider: "openai", windows: [] };
              return {};
            }),
          frames: Stream.fromQueue(frames),
          restart: () => Effect.void,
          stop: Effect.void,
          setRuntimeMode: () => Effect.void,
          onSessionIdentityMayHaveChanged: Effect.void,
          applyModelSelection: () => Effect.void,
        };
        const adapter = yield* makeNeoPiAdapter({
          settings,
          instanceId,
          binary: "npi",
          cwd: home,
          t3Home: home,
          attachmentsDir: home,
          environment: {},
          spawn: spawner.spawn,
          discovery: hub,
          makeRuntime: () => Effect.succeed(runtime),
        });
        const observed: ProviderRuntimeEvent[] = [];
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            observed.push(event);
          }),
        ).pipe(Effect.forkScoped);
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("neopi"),
          providerInstanceId: instanceId,
          cwd: home,
          runtimeMode: "auto",
        });
        const started = yield* adapter.sendTurn({
          threadId,
          input: "plan this",
          interactionMode: "plan",
        });
        assert.deepEqual(turns, ["plan this"]);
        const usage = yield* SubscriptionRef.set(state, "ready").pipe(
          Effect.andThen(adapter.getLiveUsage("openai")),
        );
        yield* Queue.offer(frames, {
          type: "plan_proposal_request",
          id: "proposal-1",
          title: "Implementation plan",
          planFilePath: "xd://plan/test",
          planMarkdown: "# Plan\n\n- Implement it",
          turnId: started.turnId,
        });
        for (
          let attempt = 0;
          attempt < 100 &&
          (capable
            ? !observed.some((event) => event.type === "turn.proposed.completed")
            : attempt < 2);
          attempt++
        )
          yield* Effect.sleep("10 millis");
        assert.deepEqual(writes, [], "displaying a proposed plan cannot approve it");
        yield* Queue.offer(frames, {
          type: "t3.turn.outcome",
          state: "completed",
          turnId: started.turnId,
        });
        for (
          let attempt = 0;
          attempt < 100 && !observed.some((event) => event.type === "turn.completed");
          attempt++
        )
          yield* Effect.sleep("10 millis");
        if (capable) {
          const refined = yield* adapter.sendTurn({
            threadId,
            input: "Please simplify step two",
            interactionMode: "plan",
          });
          assert.deepEqual(writes, [
            {
              type: "plan_proposal_response",
              id: "proposal-1",
              decision: "refine",
              feedback: "Please simplify step two",
            },
          ]);
          assert.deepEqual(turns, ["plan this"], "feedback resumes the native turn");
          yield* Queue.offer(frames, {
            type: "t3.turn.outcome",
            state: "completed",
            turnId: refined.turnId,
          });
          for (
            let attempt = 0;
            attempt < 100 && observed.filter((event) => event.type === "turn.completed").length < 2;
            attempt++
          )
            yield* Effect.sleep("10 millis");
          yield* SubscriptionRef.set(state, "ready");
          const repeated = yield* adapter.sendTurn({
            threadId,
            input: "plan again",
            interactionMode: "plan",
          });
          proposalId = "proposal-2";
          yield* Queue.offer(frames, {
            type: "plan_proposal_request",
            id: proposalId,
            title: "Revised plan",
            planFilePath: "xd://plan/revised",
            planMarkdown: "# Plan\n\n- Implement it",
            turnId: repeated.turnId,
          });
          for (
            let attempt = 0;
            attempt < 100 &&
            observed.filter((event) => event.type === "turn.proposed.completed").length < 2;
            attempt++
          )
            yield* Effect.sleep("10 millis");
          assert.equal(writes.length, 1, "displaying a revised plan cannot approve it");
          yield* Queue.offer(frames, {
            type: "t3.turn.outcome",
            state: "completed",
            turnId: repeated.turnId,
          });
          for (
            let attempt = 0;
            attempt < 100 && observed.filter((event) => event.type === "turn.completed").length < 3;
            attempt++
          )
            yield* Effect.sleep("10 millis");
        }
        yield* adapter.sendTurn({
          threadId,
          input: capable
            ? "PLEASE IMPLEMENT THIS PLAN:\n# Plan\n\n- Implement it"
            : "implement this",
          interactionMode: "default",
        });
        assert.deepEqual(
          turns,
          capable
            ? ["plan this", "plan again", "PLEASE IMPLEMENT THIS PLAN:\n# Plan\n\n- Implement it"]
            : ["plan this", "implement this"],
        );

        const setModeRequests = requests.filter((command) => command.type === "set_mode");
        const usageRequests = requests.filter((command) => command.type === "get_usage");
        if (capable) {
          assert.deepEqual(setModeRequests, [
            { type: "set_mode", mode: "plan" },
            { type: "set_mode", mode: "default" },
          ]);
          assert.deepEqual(usageRequests, [
            { type: "get_usage", provider: "openai", redact: true },
          ]);
          assert.deepEqual(usage, { provider: "openai", windows: [] });
          assert.deepEqual(writes, [
            {
              type: "plan_proposal_response",
              id: "proposal-1",
              decision: "refine",
              feedback: "Please simplify step two",
            },
            { type: "plan_proposal_response", id: "proposal-2", decision: "approve" },
          ]);
          assert.equal(
            observed.find((event) => event.type === "turn.proposed.completed")?.payload
              .planMarkdown,
            "# Plan\n\n- Implement it",
          );
        } else {
          assert.deepEqual(setModeRequests, []);
          assert.deepEqual(usageRequests, []);
          assert.equal(usage, undefined);
          assert.deepEqual(writes, []);
          assert.equal(
            observed.some((event) => event.type === "turn.proposed.completed"),
            false,
          );
        }
        yield* adapter.stopAll();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

for (const skipConversationRestore of [false, true])
  it.live(
    `rollback ${skipConversationRestore ? "rejects preserved live messages" : "persists the branched cursor"}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "neopi-rollback-adapter-" });
          const hub = yield* makeNeoPiDiscoveryHub();
          const state = yield* SubscriptionRef.make<NeoPiRuntimeState>("stopped");
          const frames = yield* Queue.unbounded<NeoPiRuntimeFrame>();
          const cursor = yield* SubscriptionRef.make<NeoPiResumeCursor>({
            v: 1,
            sessionId: "old",
            sessionFile: `${home}/old.jsonl`,
            sessionDir: home,
            turnBoundaries: [{ turnId: TurnId.make("first"), userEntryId: "u1" }],
          });
          const entries = [
            {
              id: "u1",
              parentId: null,
              type: "message",
              message: { role: "user", content: [{ type: "text", text: "first" }] },
            },
            {
              id: "a1",
              parentId: "u1",
              type: "message",
              message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
            },
            { id: "custom", parentId: "a1", type: "custom_message", content: "notice" },
            {
              id: "summary",
              parentId: "custom",
              type: "branch_summary",
              summary: "earlier branch",
            },
            { id: "compact", parentId: "summary", type: "compaction", summary: "compressed" },
          ];
          let branched = false;
          let preserveLiveMessages = skipConversationRestore;
          const resumedSessions: string[] = [];
          const requests: string[] = [];
          let runningTurnId: TurnId | undefined;
          const runtime: NeoPiSessionRuntimeShape = {
            threadId,
            state,
            cursor,
            capabilities: new Set(["v2"]),
            start: SubscriptionRef.set(state, "ready"),
            startTurn: (input) =>
              Effect.sync(() => {
                runningTurnId = input.turnId;
                return { turnId: input.turnId };
              }).pipe(Effect.tap(() => SubscriptionRef.set(state, "running"))),
            steer: () => Effect.void,
            interrupt: Effect.gen(function* () {
              requests.push("abort");
              yield* SubscriptionRef.set(state, "ready");
              yield* Queue.offer(frames, {
                type: "t3.turn.outcome",
                state: "interrupted",
                ...(runningTurnId ? { turnId: runningTurnId } : {}),
              });
            }),
            compact: () => Effect.void,
            resolvePlanProposal: () => Effect.void,
            respondUi: () => Effect.void,
            writeFrame: () => Effect.void,
            request: (cmd) =>
              Effect.sync(() => {
                requests.push(`${cmd.type}:${"entryId" in cmd ? String(cmd.entryId) : ""}`);
                if (cmd.type === "get_entries")
                  return { entries: branched ? [] : entries, leafId: branched ? null : "compact" };
                if (cmd.type === "branch") {
                  branched = true;
                  return { cancelled: false };
                }
                if (cmd.type === "get_state")
                  return { sessionFile: `${home}/new.jsonl`, sessionId: "new" };
                return {
                  messages:
                    branched && !preserveLiveMessages
                      ? []
                      : [
                          ...entries
                            .slice(0, 2)
                            .flatMap((entry) => ("message" in entry ? [entry.message] : [])),
                          { role: "custom", content: "notice" },
                          { role: "branchSummary", summary: "earlier branch" },
                          { role: "compactionSummary", summary: "compressed" },
                        ],
                };
              }),
            frames: Stream.fromQueue(frames),
            restart: () =>
              Effect.gen(function* () {
                const original = yield* SubscriptionRef.get(cursor);
                resumedSessions.push(original.sessionFile);
                branched = false;
                yield* SubscriptionRef.set(state, "ready");
              }),
            stop: Effect.void,
            setRuntimeMode: () => Effect.void,
            onSessionIdentityMayHaveChanged: Effect.void,
            applyModelSelection: () => Effect.void,
          };
          const adapter = yield* makeNeoPiAdapter({
            settings,
            instanceId,
            binary: "npi",
            cwd: home,
            t3Home: home,
            attachmentsDir: home,
            environment: {},
            spawn: spawner.spawn,
            discovery: hub,
            makeRuntime: () => Effect.succeed(runtime),
          });
          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("neopi"),
            providerInstanceId: instanceId,
            cwd: home,
            runtimeMode: "auto",
          });
          assert.deepEqual(
            (yield* adapter.readThread(threadId)).turns.map((turn) => turn.items.length),
            [5],
          );
          yield* adapter.sendTurn({ threadId, input: "first" });
          const rewind = yield* Effect.exit(adapter.rollbackThread(threadId, 1));
          assert.ok(requests.indexOf("abort") >= 0);
          assert.ok(requests.indexOf("abort") < requests.indexOf("branch:u1"));
          if (skipConversationRestore) {
            assert.equal(rewind._tag, "Failure");
            if (rewind._tag === "Failure")
              assert.match(Cause.pretty(rewind.cause), /rollback integrity error/);
            assert.deepEqual(resumedSessions, [`${home}/old.jsonl`]);
            const original = (yield* adapter.listSessions())[0]?.resumeCursor as NeoPiResumeCursor;
            assert.equal(original.sessionFile, `${home}/old.jsonl`);
            assert.equal(original.sessionId, "old");
            assert.equal(original.turnBoundaries.length, 1);
            assert.deepEqual(
              (yield* adapter.readThread(threadId)).turns.map((turn) => turn.items.length),
              [5],
            );
            yield* adapter.sendTurn({ threadId, input: "retry after failed rewind" });
            preserveLiveMessages = false;
            const retried = yield* adapter.rollbackThread(threadId, 1);
            assert.deepEqual(retried.turns, []);
          } else {
            assert.equal(rewind._tag, "Success");
            if (rewind._tag === "Success") assert.deepEqual(rewind.value.turns, []);
          }
          assert.ok(requests.includes("branch:u1"));
          const saved = (yield* adapter.listSessions())[0]?.resumeCursor as NeoPiResumeCursor;
          assert.equal(saved.sessionFile, `${home}/new.jsonl`);
          assert.equal(saved.sessionId, "new");
          assert.deepEqual(saved.turnBoundaries, []);
          const resumedState = yield* SubscriptionRef.make<NeoPiRuntimeState>("stopped");
          const resumedCursor = yield* SubscriptionRef.make(saved);
          const resumed = yield* makeNeoPiAdapter({
            settings,
            instanceId,
            binary: "npi",
            cwd: home,
            t3Home: home,
            attachmentsDir: home,
            environment: {},
            spawn: spawner.spawn,
            discovery: hub,
            makeRuntime: (input) => {
              assert.deepEqual(input.cursor, saved);
              return Effect.succeed({
                ...runtime,
                state: resumedState,
                cursor: resumedCursor,
                start: SubscriptionRef.set(resumedState, "ready"),
                frames: Stream.empty,
              });
            },
          });
          yield* resumed.startSession({
            threadId,
            provider: ProviderDriverKind.make("neopi"),
            providerInstanceId: instanceId,
            cwd: home,
            runtimeMode: "auto",
            resumeCursor: saved,
          });
          assert.deepEqual((yield* resumed.readThread(threadId)).turns, []);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

it.live("seeds host tool names before startup and renews permissions on credential rotation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      );
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = "/tmp/neopi-adapter-host-bridge";
      const captures: NeoPiRuntimeInput[] = [];
      let stops = 0;
      const grant = (capabilities: ReadonlySet<"preview" | "device" | "pull-requests">) =>
        registry.issue({ threadId, providerInstanceId: instanceId, capabilities }).pipe(
          Effect.tap(({ config }) =>
            Effect.sync(() =>
              McpProviderSession.setMcpProviderSession({
                ...config,
                ...(capabilities.has("device")
                  ? {
                      agentDeviceEnvironment: {
                        PATH: "/tmp/agent-device",
                        PATH_SEPARATOR: ":",
                        AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
                      },
                    }
                  : {}),
              }),
            ),
          ),
        );
      yield* grant(new Set(["preview", "device"]));
      const adapter = yield* makeNeoPiAdapter({
        settings,
        instanceId,
        binary: "npi",
        cwd: home,
        t3Home: home,
        attachmentsDir: home,
        environment: { PATH: "/usr/bin" },
        spawn: spawner.spawn,
        discovery: yield* makeNeoPiDiscoveryHub(),
        makeHostBridge: makeNeoPiHostToolBridge,
        makeRuntime: (input) =>
          Effect.gen(function* () {
            captures.push(input);
            const state = yield* SubscriptionRef.make<NeoPiRuntimeState>("stopped");
            const cursor = yield* SubscriptionRef.make<NeoPiResumeCursor>({
              v: 1,
              sessionId: "host-session",
              sessionFile: `${home}/session.jsonl`,
              sessionDir: home,
              turnBoundaries: [],
            });
            const frames = yield* Queue.unbounded<NeoPiRuntimeFrame>();
            const runtime: NeoPiSessionRuntimeShape = {
              threadId,
              state,
              cursor,
              capabilities: new Set(["v2"]),
              start: Queue.offer(frames, {
                type: "tool_execution_start",
                toolCallId: `tool-${captures.length}`,
                toolName: "list_thread_pull_requests",
                args: {},
              }).pipe(Effect.andThen(SubscriptionRef.set(state, "ready"))),
              startTurn: () => Effect.die("unused"),
              steer: () => Effect.die("unused"),
              interrupt: Effect.void,
              compact: () => Effect.void,
              resolvePlanProposal: () => Effect.void,
              respondUi: () => Effect.void,
              writeFrame: () => Effect.void,
              request: () => Effect.succeed({}),
              frames: Stream.fromQueue(frames),
              restart: () => Effect.void,
              stop: Effect.sync(() => {
                stops++;
              }),
              setRuntimeMode: () => Effect.void,
              onSessionIdentityMayHaveChanged: Effect.void,
              applyModelSelection: () => Effect.void,
            };
            return runtime;
          }),
      });
      const observed: ProviderRuntimeEvent[] = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          observed.push(event);
        }),
      ).pipe(Effect.forkScoped);
      const start = () =>
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("neopi"),
          providerInstanceId: instanceId,
          cwd: home,
          runtimeMode: "auto",
        });
      yield* start();
      assert.equal(captures[0]?.hostBridge?.definitions.length, 21);
      assert.equal(captures[0]?.env?.PATH, "/tmp/agent-device:/usr/bin");
      for (let count = 0; count < 100 && observed.length === 0; count++)
        yield* Effect.sleep("5 millis");
      assert.ok(
        observed.some(
          (event) =>
            event.type === "item.started" &&
            (event.payload as { itemType?: string; toolSource?: { key?: string } }).itemType ===
              "mcp_tool_call" &&
            (event.payload as { toolSource?: { key?: string } }).toolSource?.key === "t3-code",
        ),
      );
      yield* grant(new Set());
      yield* start();
      assert.equal(stops, 1);
      assert.deepEqual(
        captures[1]?.hostBridge?.definitions.map(({ name }) => name),
        ["link_pull_request", "unlink_pull_request", "list_thread_pull_requests"],
      );
      assert.equal(captures[1]?.env?.PATH, "/usr/bin");
      yield* adapter.stopAll();
    }).pipe(
      Effect.provide(McpSessionRegistry.layer),
      Effect.provideService(
        HttpServer.HttpServer,
        HttpServer.HttpServer.of({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
          serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
        }),
      ),
      Effect.provideService(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("host-adapter-test")),
          getDescriptor: Effect.die("unused"),
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  ),
);
