import type { ThreadId } from "@t3tools/contracts";
import type { AgentToolResultWire, HostToolCallFrame } from "effect-neopi-rpc/client";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { Tool } from "effect/unstable/ai";
import { invokeRegisteredMcpTool } from "../../mcp/McpHttpServer.ts";
import type { McpCapability, McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { resolveActiveMcpCredential } from "../../mcp/McpSessionRegistry.ts";
import { DeviceToolkit } from "../../mcp/toolkits/device/tools.ts";
import { PreviewToolkit } from "../../mcp/toolkits/preview/tools.ts";
import { PullRequestsToolkit } from "../../mcp/toolkits/pullRequests/tools.ts";

export interface NeoPiHostToolBridge {
  readonly definitions: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    readonly loadMode: "discoverable";
  }>;
  readonly handle: (
    call: HostToolCallFrame,
    signal: AbortSignal,
  ) => Effect.Effect<AgentToolResultWire>;
}

const definitionsFor = (tools: Record<string, Tool.Any>) =>
  Object.values(tools).map((tool) => ({
    name: tool.name,
    description: Tool.getDescription(tool),
    parameters: Tool.getJsonSchema(tool),
    loadMode: "discoverable" as const,
  }));

const failed = (message: string): AgentToolResultWire => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** The same registered handlers used by Codex over MCP, but without RPC bearer frames. */
export const makeNeoPiHostToolBridge = Effect.fn("NeoPiHostToolBridge.make")(function* (input: {
  readonly threadId: ThreadId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly credential: string;
  readonly context: McpInvocationScope;
}) {
  const definitions = [
    ...(input.capabilities.has("preview") ? definitionsFor(PreviewToolkit.tools) : []),
    ...(input.capabilities.has("device") ? definitionsFor(DeviceToolkit.tools) : []),
    ...(input.capabilities.has("pull-requests") ? definitionsFor(PullRequestsToolkit.tools) : []),
  ];
  const names = new Set(definitions.map((definition) => definition.name));
  const handle: NeoPiHostToolBridge["handle"] = (call, signal) => {
    if (!names.has(call.toolName)) {
      return Effect.succeed(failed(`Unsupported host tool: ${call.toolName}`));
    }
    return Effect.gen(function* () {
      const scope = yield* resolveActiveMcpCredential(input.credential);
      if (
        !scope ||
        scope.threadId !== input.threadId ||
        scope.providerSessionId !== input.context.providerSessionId ||
        scope.providerInstanceId !== input.context.providerInstanceId
      ) {
        return failed("access revoked");
      }
      const result = yield* invokeRegisteredMcpTool(
        input.credential,
        call.toolName,
        call.arguments,
      );
      const content: AgentToolResultWire["content"][number][] = result.content.flatMap((block) =>
        block.type === "text"
          ? [{ type: "text" as const, text: block.text }]
          : block.type === "image"
            ? [
                {
                  type: "image" as const,
                  data: Buffer.from(block.data).toString("base64"),
                  mimeType: block.mimeType,
                },
              ]
            : [],
      );
      return {
        content,
        ...(result.structuredContent === undefined ? {} : { details: result.structuredContent }),
        ...(result.isError ? { isError: true } : {}),
      } satisfies AgentToolResultWire;
    }).pipe(
      Effect.raceFirst(
        Effect.callback<never, Error>((resume) => {
          if (signal.aborted) {
            resume(Effect.fail(new Error("Host tool cancelled")));
            return;
          }
          const cancel = () => resume(Effect.fail(new Error("Host tool cancelled")));
          signal.addEventListener("abort", cancel, { once: true });
          return Effect.sync(() => signal.removeEventListener("abort", cancel));
        }),
      ),
      Effect.matchCause({
        onFailure: (cause) => {
          const error = cause.reasons.find(Cause.isFailReason)?.error;
          return failed(error instanceof Error ? error.message : Cause.pretty(cause));
        },
        onSuccess: (result) => result,
      }),
    );
  };
  return { definitions, handle } satisfies NeoPiHostToolBridge;
});
