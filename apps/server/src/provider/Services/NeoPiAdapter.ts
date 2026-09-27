import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/** Per-instance NeoPi/OMP JSONL RPC adapter contract. */
export interface NeoPiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
