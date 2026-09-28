import * as Schema from "effect/Schema";

import { isRecord } from "./schema.ts";

/**
 * Physical stdout frame cap advertised by NeoPi/OMP protocol v1.
 * Inbound commands are never chunked; this is the peer's physical ceiling.
 */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;

/** Default logical-frame ceiling when `ready.maxReassembledFrameBytes` is absent. */
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;

/** Decoded payload cap of one `rpc_chunk`, matching NeoPi `rpc-frame.ts`. */
export const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

export interface RpcChunkFrame {
  readonly type: "rpc_chunk";
  readonly chunkId: string;
  readonly index: number;
  readonly count: number;
  readonly byteLength: number;
  readonly data: string;
}

interface PendingRpcChunks {
  readonly chunkId: string;
  readonly count: number;
  readonly byteLength: number;
  nextIndex: number;
  readonly chunks: Array<Buffer>;
  receivedBytes: number;
}

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * A 3-chunk sequence cannot both satisfy NeoPi's 1 MiB `byteLength` floor and
 * the 256 KiB per-chunk payload cap (3 × 256 KiB = 768 KiB). The receiver
 * therefore does not enforce that sender floor. Real oversized frames still
 * reassemble: they arrive as 4 or more chunks under `maxReassembledFrameBytes`.
 */
export class RpcFrameDecoder {
  #pending: PendingRpcChunks | undefined;
  readonly #ceiling: number;

  constructor(ceiling: number = MAX_RPC_REASSEMBLED_BYTES) {
    this.#ceiling = ceiling;
  }

  /** Throw if a chunk sequence is still open when stdout ends. */
  finish(): void {
    if (this.#pending) {
      throw new Error("rpc chunk sequence truncated");
    }
  }

  /** Return a logical frame, or `undefined` while more chunks are required. */
  push(value: unknown): Record<string, unknown> | undefined {
    if (!isRpcChunkFrame(value)) {
      if (this.#pending) {
        throw new Error("rpc chunk sequence interrupted");
      }
      if (!isRecord(value)) {
        throw new Error("rpc frame must be an object");
      }
      return value;
    }

    const { chunkId, index, count, byteLength } = value;
    const maxCount = Math.max(2, Math.ceil(this.#ceiling / RPC_CHUNK_PAYLOAD_BYTES));
    if (
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      index < 0 ||
      count < 2 ||
      count > maxCount ||
      index >= count ||
      byteLength < 1 ||
      byteLength > this.#ceiling
    ) {
      throw new Error("invalid rpc chunk metadata");
    }

    const bytes = decodeCanonicalBase64(value.data);
    if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) {
      throw new Error("rpc chunk payload exceeds the transport limit");
    }

    if (!this.#pending) {
      if (index !== 0) {
        throw new Error("rpc chunk sequence must start at index 0");
      }
      this.#pending = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
    }
    const pending = this.#pending;
    if (
      pending.chunkId !== chunkId ||
      pending.count !== count ||
      pending.byteLength !== byteLength ||
      pending.nextIndex !== index
    ) {
      throw new Error("rpc chunk sequence mismatch");
    }
    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex++;
    if (pending.receivedBytes > pending.byteLength) {
      throw new Error("rpc chunk sequence exceeds declared length");
    }
    if (pending.nextIndex < pending.count) {
      return undefined;
    }
    if (pending.receivedBytes !== pending.byteLength) {
      throw new Error("rpc chunk sequence length mismatch");
    }

    this.#pending = undefined;
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
    } catch {
      throw new Error("rpc chunk sequence is not strict UTF-8");
    }
    let frame: unknown;
    try {
      frame = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(decoded);
    } catch {
      throw new Error("reassembled rpc frame is not JSON");
    }
    if (!isRecord(frame)) {
      throw new Error("rpc frame must be an object");
    }
    return frame;
  }
}

export const isRpcChunkFrame = (value: unknown): value is RpcChunkFrame =>
  isRecord(value) &&
  value.type === "rpc_chunk" &&
  typeof value.chunkId === "string" &&
  typeof value.index === "number" &&
  typeof value.count === "number" &&
  typeof value.byteLength === "number" &&
  typeof value.data === "string";

/** Split a logical JSON object into ordered `rpc_chunk` frames. Test and fixture helper. */
export const encodeRpcChunks = (
  json: string,
  chunkId: string,
  chunkBytes: number = RPC_CHUNK_PAYLOAD_BYTES,
): Array<RpcChunkFrame> => {
  const bytes = Buffer.from(json, "utf8");
  const size = Math.max(1, Math.min(chunkBytes, Math.max(1, bytes.byteLength - 1)));
  const count = Math.ceil(bytes.byteLength / size);
  const frames: Array<RpcChunkFrame> = [];
  for (let index = 0; index < count; index++) {
    const slice = bytes.subarray(index * size, Math.min(bytes.byteLength, (index + 1) * size));
    frames.push({
      type: "rpc_chunk",
      chunkId,
      index,
      count,
      byteLength: bytes.byteLength,
      data: slice.toString("base64"),
    });
  }
  return frames;
};

const decodeCanonicalBase64 = (data: string): Buffer => {
  if (data.length === 0 || !CANONICAL_BASE64.test(data)) {
    throw new Error("invalid rpc chunk data");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) {
    throw new Error("invalid rpc chunk data");
  }
  return bytes;
};
