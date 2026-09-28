import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { PlatformError } from "effect/PlatformError";

const encoder = new TextEncoder();

export interface StderrTail {
  buffer: Buffer;
}

export const emptyStderrTail = (): StderrTail => ({ buffer: Buffer.alloc(0) });

export const pushStderrTail = (tail: StderrTail, chunk: Uint8Array, limit: number): void => {
  const next = Buffer.concat([tail.buffer, Buffer.from(chunk)]);
  tail.buffer = next.byteLength > limit ? next.subarray(next.byteLength - limit) : next;
};

export const stderrTailText = (tail: StderrTail): string =>
  new TextDecoder("utf-8", { fatal: false }).decode(tail.buffer);

export const encodeFrameLine = (frame: unknown): Uint8Array =>
  encoder.encode(`${JSON.stringify(frame)}\n`);

/** Pull newline-delimited text from a byte stream, including a trailing partial line. */
export const stdoutLines = (
  stdout: Stream.Stream<Uint8Array, PlatformError>,
): Stream.Stream<string, PlatformError> =>
  Stream.decodeText(stdout).pipe(
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
  );

export const signalFromExitFailure = (error: unknown): string | null => {
  const text = collectText(error);
  const match = /signal: '([^']+)'/.exec(text);
  return match?.[1] ?? null;
};

const collectText = (value: unknown, depth = 0): string => {
  if (depth > 5 || value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Error) {
    return `${value.message} ${collectText(value.cause, depth + 1)}`;
  }
  if (typeof value === "object") {
    return Object.values(value)
      .map((entry) => collectText(entry, depth + 1))
      .join(" ");
  }
  return "";
};

export const endQueue = <A>(queue: Queue.Queue<A, Cause.Done<void>>): Effect.Effect<void> =>
  Queue.end(queue).pipe(Effect.ignore);
