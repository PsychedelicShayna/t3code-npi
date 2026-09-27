import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import { McpServer } from "effect/unstable/ai";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as ServerConfig from "../../config.ts";
import { DeviceService } from "../../device/DeviceService.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeNeoPiHostToolBridge } from "./NeoPiHostToolBridge.ts";
const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const environmentId = EnvironmentId.make("environment-bridge-test");
const threadId = ThreadId.make("thread-bridge-test");
const instanceId = ProviderInstanceId.make("neopi-bridge-test");
const projectId = ProjectId.make("project-bridge-test");
const fakeHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});
const thread = {
  id: threadId,
  projectId,
  title: "Bridge test",
  modelSelection: { instanceId, model: "test" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
const screenshot = new Uint8Array(24);
const view = new DataView(screenshot.buffer);
view.setUint32(0, 0x89504e47);
view.setUint32(4, 0x0d0a1a0a);
view.setUint32(12, 0x49484452);
view.setUint32(16, 24);
view.setUint32(20, 42);
const device = {
  hostId: "local",
  id: "device-1",
  platform: "ios" as const,
  name: "Test device",
  version: "iOS 27",
  booted: true,
  physical: false,
};

const ToolkitLayer = Layer.mergeAll(
  McpHttpServer.PreviewToolkitRegistrationLive,
  McpHttpServer.DeviceToolkitRegistrationLive,
  McpHttpServer.PullRequestsToolkitRegistrationLive,
  McpHttpServer.InProcessToolkitLive,
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpSessionRegistry.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(
    Layer.mock(DeviceService)({
      state: Effect.succeed({
        hosts: [],
        hostStatus: "ready",
        hostStatuses: {},
        devices: [device],
        sessions: [],
        onboardingCompleted: true,
        agentAccessEnabled: true,
        hubBasePath: "/api/device-hub",
        revision: 1,
      }),
      sessionsForThread: () =>
        Effect.succeed([
          {
            threadId,
            hostId: "local",
            deviceId: "device-1",
            platform: "ios",
            openedAt: "2026-09-01T00:00:00.000Z",
          },
        ]),
      screenshot: () => Effect.succeed({ device, png: screenshot }),
    }),
  ),
  Layer.provideMerge(Layer.mock(OrchestrationEngineService)({})),
  Layer.provideMerge(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () => Effect.succeedSome(thread),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
  Layer.provideMerge(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-neopi-host-bridge-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const call = (name: string, args: Record<string, unknown> = {}) => ({
  type: "host_tool_call" as const,
  id: `request-${name}`,
  toolCallId: `tool-${name}`,
  toolName: name,
  arguments: args,
});

it.effect(
  "advertises exactly the project-granted catalog and runs PR, preview, and device via MCP handlers",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const issued = yield* registry.issue({
          threadId,
          providerInstanceId: instanceId,
          capabilities: new Set(["preview", "device"]),
        });
        const scope = (yield* registry.resolve(issued.config.authorizationHeader.slice(7)))!;
        const bridge = yield* makeNeoPiHostToolBridge({
          threadId,
          capabilities: scope.capabilities,
          credential: issued.config.authorizationHeader,
          context: scope,
        });
        expect(bridge.definitions).toHaveLength(21);
        expect(bridge.definitions.map(({ name }) => name)).toEqual(
          expect.arrayContaining([
            "preview_snapshot",
            "device_screenshot",
            "list_thread_pull_requests",
          ]),
        );
        expect(
          bridge.definitions.every(
            (tool) => tool.loadMode === "discoverable" && typeof tool.parameters === "object",
          ),
        ).toBe(true);
        const pullRequests = yield* bridge.handle(
          call("list_thread_pull_requests"),
          new AbortController().signal,
        );
        expect(pullRequests.isError).not.toBe(true);
        expect(
          decodeResult(
            pullRequests.content[0]!.type === "text" ? pullRequests.content[0]!.text : "null",
          ),
        ).toMatchObject({ pullRequests: [], chains: [] });
        const shot = yield* bridge.handle(
          call("device_screenshot", { deviceId: "device-1" }),
          new AbortController().signal,
        );
        expect(shot.isError).not.toBe(true);
        expect(shot.content.map((block) => block.type)).toEqual(["text", "image"]);
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        const connected = yield* Deferred.make<void>();
        const events = yield* broker.connect({ clientId: "bridge-preview-host", environmentId });
        yield* Stream.runForEach(events, (event) =>
          event.type === "connected"
            ? Deferred.succeed(connected, undefined)
            : broker.respond({
                clientId: "bridge-preview-host",
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: true,
                result:
                  event.request.operation === "snapshot"
                    ? {
                        url: "http://example.test/",
                        title: "Example",
                        loading: false,
                        visibleText: "A browser page",
                        interactiveElements: [],
                        accessibilityTree: {},
                        consoleEntries: [],
                        networkEntries: [],
                        actionTimeline: [],
                        screenshot: {
                          mimeType: "image/png",
                          data: Buffer.from("png").toString("base64"),
                          width: 10,
                          height: 5,
                        },
                      }
                    : {
                        available: true,
                        visible: true,
                        tabId: null,
                        url: "http://example.test/",
                        title: "Example",
                        loading: false,
                      },
              }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(connected);
        const preview = yield* bridge.handle(call("preview_status"), new AbortController().signal);
        expect(preview.isError).not.toBe(true);
        expect(
          preview.content.some(
            (block) => block.type === "text" && block.text.includes("example.test"),
          ),
        ).toBe(true);
        const snapshot = yield* bridge.handle(
          call("preview_snapshot"),
          new AbortController().signal,
        );
        expect(snapshot.isError).not.toBe(true);
        expect(snapshot.content.at(-1)).toEqual({
          type: "image",
          mimeType: "image/png",
          data: Buffer.from("png").toString("base64"),
        });
        expect(snapshot.details).toMatchObject({
          url: "http://example.test/",
          screenshot: { mimeType: "image/png", width: 10, height: 5 },
        });
        const unavailable = yield* bridge.handle(
          call("unknown_tool"),
          new AbortController().signal,
        );
        expect(unavailable).toMatchObject({ isError: true });
        yield* registry.revokeThread(threadId);
        const revoked = yield* bridge.handle(
          call("list_thread_pull_requests"),
          new AbortController().signal,
        );
        expect(revoked).toMatchObject({
          isError: true,
          content: [{ type: "text", text: "access revoked" }],
        });
      }).pipe(Effect.provide(ToolkitLayer)),
    ),
);

it.effect("with PR-only grants, no browser or device tool is registered", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: instanceId,
        capabilities: new Set(),
      });
      const scope = (yield* registry.resolve(issued.config.authorizationHeader.slice(7)))!;
      const bridge = yield* makeNeoPiHostToolBridge({
        threadId,
        capabilities: scope.capabilities,
        credential: issued.config.authorizationHeader,
        context: scope,
      });
      expect(bridge.definitions.map(({ name }) => name)).toEqual([
        "link_pull_request",
        "unlink_pull_request",
        "list_thread_pull_requests",
      ]);
      const denied = yield* bridge.handle(call("preview_status"), new AbortController().signal);
      expect(denied.isError).toBe(true);
      const bypass = yield* McpHttpServer.invokeRegisteredMcpTool(
        issued.config.authorizationHeader,
        "device_list",
        {},
      ).pipe(Effect.flip);
      expect(bypass.message).toBe("access revoked");
    }).pipe(Effect.provide(ToolkitLayer)),
  ),
);

it.effect("aborts an in-flight browser invocation without waiting for its host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: instanceId,
        capabilities: new Set(["preview"]),
      });
      const scope = (yield* registry.resolve(issued.config.authorizationHeader.slice(7)))!;
      const bridge = yield* makeNeoPiHostToolBridge({
        threadId,
        capabilities: scope.capabilities,
        credential: issued.config.authorizationHeader,
        context: scope,
      });
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const requested = yield* Deferred.make<void>();
      const events = yield* broker.connect({ clientId: "bridge-cancel-host", environmentId });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Deferred.succeed(connected, undefined)
          : Deferred.succeed(requested, undefined),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      const controller = new AbortController();
      const pending = yield* bridge
        .handle(call("preview_status"), controller.signal)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(requested);
      controller.abort();
      const result = yield* Fiber.join(pending);
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Host tool cancelled" }],
      });
    }).pipe(Effect.provide(ToolkitLayer)),
  ),
);
