import type * as Effect from "effect/Effect";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/** Per-instance NeoPi/OMP JSONL RPC adapter contract. */
export interface NeoPiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly getLiveUsage: (
    activeProvider: string,
  ) => Effect.Effect<unknown | undefined, ProviderAdapterError>;
}
