import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type NeoPiSettings,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
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
