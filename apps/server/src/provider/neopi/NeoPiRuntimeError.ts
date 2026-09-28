import * as Data from "effect/Data";

export class NeoPiRuntimeError extends Data.TaggedError("NeoPiRuntimeError")<{
  readonly code:
    | "settings"
    | "identity_mismatch"
    | "not_running"
    | "not_ready"
    | "busy"
    | "spawn"
    | "rpc"
    | "startup"
    | "session_in_use"
    | "runtime_mode_deferred"
    | "closed";
  readonly message: string;
  readonly flag?: string;
  readonly cause?: unknown;
}> {}
