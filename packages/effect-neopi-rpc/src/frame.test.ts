import { assert, describe, it } from "@effect/vitest";

import { RpcFrameDecoder, encodeRpcChunks } from "./frame.ts";

const logical = (message: string) => JSON.stringify({ type: "notice", message });

describe("rpc chunk reassembly", () => {
  it("reassembles a valid 3-chunk sequence in order", () => {
    const json = logical("alpha-beta-gamma");
    const chunks = encodeRpcChunks(json, "chunk-3", 20);
    assert.equal(chunks.length, 3);
    const decoder = new RpcFrameDecoder();
    assert.isUndefined(decoder.push(chunks[0]));
    assert.isUndefined(decoder.push(chunks[1]));
    assert.deepEqual(decoder.push(chunks[2]), { type: "notice", message: "alpha-beta-gamma" });
    decoder.finish();
  });

  it("rejects an interleaved chunk id", () => {
    const decoder = new RpcFrameDecoder();
    const first = encodeRpcChunks(logical("one"), "a", 4);
    const other = encodeRpcChunks(logical("two"), "b", 4);
    assert.isUndefined(decoder.push(first[0]));
    assert.throws(() => decoder.push(other[0]), /mismatch|interrupted/);
  });

  it("rejects a sequence whose bytes do not match byteLength", () => {
    const chunks = encodeRpcChunks(logical("length"), "len", 4);
    const wrong = chunks.map((chunk) => ({ ...chunk, byteLength: chunk.byteLength + 9 }));
    const decoder = new RpcFrameDecoder();
    assert.isUndefined(decoder.push(wrong[0]));
    assert.throws(() => {
      for (const chunk of wrong.slice(1)) {
        decoder.push(chunk);
      }
    }, /length/);
  });

  it("fails a truncated sequence at EOF", () => {
    const chunks = encodeRpcChunks(logical("truncated"), "cut", 4);
    const decoder = new RpcFrameDecoder();
    assert.isUndefined(decoder.push(chunks[0]));
    assert.throws(() => decoder.finish(), /truncated/);
  });

  it("decodes a UTF-8 code point split across chunks", () => {
    const json = logical("A😀B");
    const bytes = Buffer.from(json, "utf8");
    const emoji = bytes.indexOf(Buffer.from("😀", "utf8"));
    assert.isAbove(emoji, 0);
    const splitAt = emoji + 1;
    const chunks = [
      {
        type: "rpc_chunk" as const,
        chunkId: "utf",
        index: 0,
        count: 2,
        byteLength: bytes.byteLength,
        data: bytes.subarray(0, splitAt).toString("base64"),
      },
      {
        type: "rpc_chunk" as const,
        chunkId: "utf",
        index: 1,
        count: 2,
        byteLength: bytes.byteLength,
        data: bytes.subarray(splitAt).toString("base64"),
      },
    ];
    const decoder = new RpcFrameDecoder();
    assert.isUndefined(decoder.push(chunks[0]));
    assert.deepEqual(decoder.push(chunks[1]), { type: "notice", message: "A😀B" });
  });

  it("fails a sequence above the reassembly ceiling", () => {
    const chunks = encodeRpcChunks(logical("too-big"), "ceil", 4);
    const decoder = new RpcFrameDecoder(8);
    assert.throws(() => decoder.push(chunks[0]), /metadata/);
  });

  it("rejects non-canonical base64", () => {
    const decoder = new RpcFrameDecoder();
    assert.throws(
      () =>
        decoder.push({
          type: "rpc_chunk",
          chunkId: "bad",
          index: 0,
          count: 2,
          byteLength: 1,
          data: "YQ",
        }),
      /invalid rpc chunk data/,
    );
  });
});
