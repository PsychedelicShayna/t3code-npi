import type { ModelSelection, RuntimeMode, ThreadId, TurnId } from "@t3tools/contracts";
import type {
  NeoPiRpcClient,
  SessionEventFrame,
  UiRequestFrame,
  HostToolCallFrame,
  HostToolCancelFrame,
} from "effect-neopi-rpc/client";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type * as SubscriptionRef from "effect/SubscriptionRef";
import type { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";

export interface NeoPiLaunchPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly identity:
    | { readonly kind: "fresh" }
    | { readonly kind: "resume"; readonly cursor: NeoPiResumeCursor };
}

export type NeoPiResumeCursor = {
  readonly v: 1;
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly turnBoundaries: ReadonlyArray<{ readonly turnId: TurnId; readonly userEntryId: string }>;
};

export type NeoPiRuntimeState =
  | "starting"
  | "ready"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";
export type NeoPiRuntimeFrame = (
  | SessionEventFrame
  | UiRequestFrame
  | HostToolCallFrame
  | HostToolCancelFrame
) & { readonly turnId?: TurnId };

export interface NeoPiTurnInput {
  readonly text: string;
  readonly images: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>;
  readonly modelSelection?: ModelSelection;
  readonly turnId: TurnId;
}

export interface NeoPiSessionRuntimeShape {
  readonly threadId: ThreadId;
  readonly state: SubscriptionRef.SubscriptionRef<NeoPiRuntimeState>;
  readonly cursor: SubscriptionRef.SubscriptionRef<NeoPiResumeCursor>;
  readonly capabilities: ReadonlySet<string>;
  readonly start: Effect.Effect<void, NeoPiRuntimeError>;
  readonly startTurn: (
    input: NeoPiTurnInput,
  ) => Effect.Effect<{ turnId: TurnId }, NeoPiRuntimeError>;
  readonly steer: (input: NeoPiTurnInput) => Effect.Effect<void, NeoPiRuntimeError>;
  readonly interrupt: Effect.Effect<void, NeoPiRuntimeError>;
  readonly compact: (customInstructions?: string) => Effect.Effect<void, NeoPiRuntimeError>;
  readonly respondUi: NeoPiRpcClient["respondUi"];
  readonly request: NeoPiRpcClient["request"];
  readonly writeFrame: NeoPiRpcClient["writeFrame"];
  readonly frames: Stream.Stream<NeoPiRuntimeFrame>;
  readonly restart: (reason: "runtime-mode-change") => Effect.Effect<void, NeoPiRuntimeError>;
  readonly stop: Effect.Effect<void>;
  readonly setRuntimeMode: (mode: RuntimeMode) => Effect.Effect<void, NeoPiRuntimeError>;
  readonly onSessionIdentityMayHaveChanged: Effect.Effect<void, NeoPiRuntimeError>;
  readonly applyModelSelection: (
    selection: ModelSelection,
  ) => Effect.Effect<void, NeoPiRuntimeError>;
}
