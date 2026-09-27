/**
 * Turn a rolling bash output snapshot into either a suffix delta or a full
 * replacement. NeoPi's bash tool streams a tail buffer (`streamTailUpdates`),
 * so each update is the current window, not an append-only chunk. When the
 * window rolls, `next` no longer starts with `prev`.
 *
 * Comparison is Unicode-safe: a trailing unpaired UTF-16 high surrogate is an
 * incomplete code point and is not sliced into a delta. The completed code
 * point is emitted once, on the snapshot that finishes it.
 */
export type SnapshotDelta = { readonly delta: string } | { readonly replace: string };

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;

function withoutTrailingIncompleteCodePoint(value: string): string {
  if (value.length === 0) {
    return value;
  }
  const last = value.charCodeAt(value.length - 1);
  if (last >= HIGH_SURROGATE_START && last <= HIGH_SURROGATE_END) {
    return value.slice(0, -1);
  }
  return value;
}

export function snapshotDelta(prev: string, next: string): SnapshotDelta {
  const prevComplete = withoutTrailingIncompleteCodePoint(prev);
  const nextComplete = withoutTrailingIncompleteCodePoint(next);
  if (nextComplete.startsWith(prevComplete)) {
    return { delta: nextComplete.slice(prevComplete.length) };
  }
  return { replace: next };
}
