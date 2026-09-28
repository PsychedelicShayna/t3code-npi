import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  UsageProviderKind,
} from "./usage.ts";

describe("UsageProviderKind", () => {
  it("accepts neopi without bumping the usage contract", () => {
    // Adding a provider is additive: unknown entries are skipped on decode.
    // v4 Claude/Codex buckets remain mergeable, so neither version moves.
    expect(USAGE_CONTRACT_VERSION).toBe(6);
    expect(USAGE_MERGE_COMPATIBLE_SINCE).toBe(4);
    expect(Schema.decodeUnknownSync(UsageProviderKind)("neopi")).toBe("neopi");
  });
});
