import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decodeFrameLine } from "./schema.ts";

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

it.effect("passes unknown frame types through with their fields", () =>
  Effect.gen(function* () {
    const line = yield* encodeJson({
      type: "extension_error",
      extensionPath: "redacted-extension",
      event: "load",
    });
    const frame = yield* decodeFrameLine(line);
    assert.equal(frame.type, "extension_error");
    if (frame.type === "extension_error") {
      assert.equal(frame.event, "load");
    }
  }),
);

it.effect("decodes a ready frame without dropping advertised limits", () =>
  Effect.gen(function* () {
    const line = yield* encodeJson({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1048576,
      maxReassembledFrameBytes: 67108864,
    });
    const frame = yield* decodeFrameLine(line);
    assert.equal(frame.type, "ready");
    if (frame.type !== "ready") {
      return;
    }
    assert.deepEqual(frame.supportedProtocolVersions, [1, 2]);
    assert.equal(frame.maxReassembledFrameBytes, 67108864);
  }),
);

it.effect("rejects a JSON line that is not an object", () =>
  Effect.gen(function* () {
    const error = yield* decodeFrameLine("[]").pipe(Effect.flip);
    assert.equal(error.code, "bad_frame");
  }),
);
