import * as Data from "effect/Data";

/** Transport failure for the NeoPi/OMP JSONL stdio client. */
export class NeoPiRpcError extends Data.TaggedError("NeoPiRpcError")<{
  readonly code?: string;
  readonly message: string;
  readonly command?: string;
}> {}
