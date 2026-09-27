import { describe, expect, it } from "vite-plus/test";

import { snapshotDelta } from "./snapshotDelta.ts";

describe("snapshotDelta", () => {
  it("extracts successive suffixes from cumulative snapshots", () => {
    expect(snapshotDelta("", "a")).toEqual({ delta: "a" });
    expect(snapshotDelta("a", "ab")).toEqual({ delta: "b" });
    expect(snapshotDelta("ab", "abc")).toEqual({ delta: "c" });
  });

  it("replaces rather than appends when the rolling tail loses its prefix", () => {
    expect(snapshotDelta("abcde", "bcdef")).toEqual({ replace: "bcdef" });
  });

  it("waits for both UTF-16 halves before emitting a code point", () => {
    expect(snapshotDelta("", "a\ud83d")).toEqual({ delta: "a" });
    expect(snapshotDelta("a\ud83d", "a\ud83d\ude00")).toEqual({ delta: "😀" });
    expect(snapshotDelta("a😀", "a😀!")).toEqual({ delta: "!" });
  });
});
