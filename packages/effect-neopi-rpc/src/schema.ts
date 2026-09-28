import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NeoPiRpcError } from "./errors.ts";

/**
 * Permissive frame model. Unknown `type`s decode to `{ type, ...rest }` and
 * are passed through; known frames are not stripped.
 */
export interface ReadyFrame {
  readonly type: "ready";
  readonly protocolVersion: number;
  readonly supportedProtocolVersions?: ReadonlyArray<number>;
  readonly maxFrameBytes?: number;
  readonly maxReassembledFrameBytes?: number;
  readonly capabilities?: ReadonlyArray<string>;
}

export interface ResponseFrame {
  readonly type: "response";
  readonly id?: string;
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly code?: string;
}

export interface UiRequestFrame {
  readonly type: "extension_ui_request";
  readonly id: string;
  readonly method:
    | "select"
    | "confirm"
    | "input"
    | "editor"
    | "cancel"
    | "notify"
    | "setStatus"
    | "setWidget"
    | "setTitle"
    | "set_editor_text"
    | "open_url";
  readonly [k: string]: unknown;
}

export interface HostToolCallFrame {
  readonly type: "host_tool_call";
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
}

export interface HostToolCancelFrame {
  readonly type: "host_tool_cancel";
  readonly id: string;
  readonly targetId: string;
}

export interface HostUriRequestFrame {
  readonly type: "host_uri_request";
  readonly id: string;
  readonly operation: "read" | "write";
  readonly url: string;
  readonly content?: string;
}

/** AgentSessionEvent, subagent frames, and other side channels. */
export interface SessionEventFrame {
  readonly type: string;
  readonly [k: string]: unknown;
}

export type NeoPiChatMode = "chat" | "erp" | "raw" | "off";

export interface SetChatModeCommand {
  readonly type: "set_chat_mode";
  readonly mode: NeoPiChatMode;
  readonly include?: string;
}

export interface SetChatModeResult {
  readonly mode: NeoPiChatMode;
  readonly include?: string;
}

export interface ChatModeChangedFrame {
  readonly type: "chat_mode_changed";
  readonly mode: NeoPiChatMode;
  readonly include?: string;
}

/** `get_state` on peers before #109 simply omits this field. */
export interface NeoPiChatModeState {
  readonly chatMode?: NeoPiChatMode;
}

export type NeoPiInteractionMode = "default" | "plan";

export interface SetModeCommand {
  readonly type: "set_mode";
  readonly mode: NeoPiInteractionMode;
  readonly planFilePath?: string;
}

export interface SetModeResult {
  readonly mode: NeoPiInteractionMode;
  readonly planFilePath?: string;
}

export interface ModeChangedFrame {
  readonly type: "mode_changed";
  readonly mode: NeoPiInteractionMode;
  readonly planFilePath?: string;
}

export interface NeoPiModeState {
  readonly mode?: NeoPiInteractionMode;
  readonly planMode?: {
    readonly planFilePath: string;
    readonly workflow: string;
  };
}

export interface PlanProposalRequestFrame {
  readonly type: "plan_proposal_request";
  readonly id: string;
  readonly title: string;
  readonly planFilePath: string;
  readonly planMarkdown: string;
}

export interface PlanProposalResponseFrame {
  readonly type: "plan_proposal_response";
  readonly id: string;
  readonly decision: "approve" | "refine";
  readonly feedback?: string;
}

export interface NeoPiRole {
  readonly id: string;
  readonly alias: string;
  readonly name: string;
  readonly tag?: string;
  readonly section?: string;
  readonly source: "builtin" | "configured";
  readonly configured?: string;
  readonly patterns: ReadonlyArray<string>;
  readonly resolved?: {
    readonly provider: string;
    readonly modelId: string;
    readonly thinkingLevel?: string;
  };
  readonly hidden: boolean;
}

export interface GetRolesResult {
  readonly roles: ReadonlyArray<NeoPiRole>;
  readonly activeRole?: string;
}

export interface SetRoleCommand {
  readonly type: "set_role";
  readonly role: string;
}

export interface SetRoleResult {
  readonly role: string;
  readonly model: unknown;
  readonly thinkingLevel?: string;
}

export interface NeoPiRoleState {
  readonly activeRole?: string;
}

export type Frame =
  | ReadyFrame
  | ResponseFrame
  | UiRequestFrame
  | HostToolCallFrame
  | HostToolCancelFrame
  | HostUriRequestFrame
  | ModeChangedFrame
  | PlanProposalRequestFrame
  | SessionEventFrame;

export interface PromptImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface PromptCommand {
  readonly id?: string;
  readonly type: "prompt";
  readonly message: string;
  readonly images?: ReadonlyArray<PromptImage>;
  readonly streamingBehavior?: "steer" | "followUp";
}

export interface TextContentWire {
  readonly type: "text";
  readonly text: string;
}

export interface ImageContentWire {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

/** Subset of NeoPi `AgentToolResult` written on host-tool frames. */
export interface AgentToolResultWire {
  readonly content: ReadonlyArray<TextContentWire | ImageContentWire>;
  readonly details?: unknown;
  readonly isError?: boolean;
}

/** `host_uri_result` written by the host. */
export interface HostUriResultWire {
  readonly type: "host_uri_result";
  readonly id: string;
  readonly content?: string;
  readonly contentType?: "text/markdown" | "application/json" | "text/plain";
  readonly notes?: ReadonlyArray<string>;
  readonly immutable?: boolean;
  readonly isError?: boolean;
  readonly error?: string;
}

export interface UiResponseWire {
  readonly id: string;
  readonly value?: string;
  readonly confirmed?: boolean;
  readonly cancelled?: true;
  readonly timedOut?: boolean;
}

const decodeJsonLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Decode one JSONL line into a permissive frame. Extra fields are kept. */
export const decodeFrameLine = (line: string): Effect.Effect<Frame, NeoPiRpcError> =>
  decodeJsonLine(line).pipe(
    Effect.mapError(
      () =>
        new NeoPiRpcError({
          code: "bad_frame",
          message: "invalid JSON frame",
        }),
    ),
    Effect.flatMap((value) => {
      if (!isRecord(value) || typeof value.type !== "string") {
        return Effect.fail(
          new NeoPiRpcError({
            code: "bad_frame",
            message: "rpc frame must be an object with a string type",
          }),
        );
      }
      return Effect.succeed(value as Frame);
    }),
  );
