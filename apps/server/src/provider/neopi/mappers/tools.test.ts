import { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedItemId } from "./MapCtx.ts";

import {
  emptyToolState,
  mapToolFrame,
  withHostToolNames,
  type ToolMapCtx,
  type ToolState,
} from "./tools.ts";

function context(): ToolMapCtx {
  let eventId = 0;
  return {
    provider: ProviderDriverKind.make("neopi"),
    providerInstanceId: ProviderInstanceId.make("neopi-1"),
    threadId: ThreadId.make("thread-1"),
    turnId: TurnId.make("turn-1"),
    now: () => "2026-09-27T00:00:00.000Z",
    newEventId: () => `event-${++eventId}`,
  };
}

function run(frames: readonly unknown[], initialState: ToolState = emptyToolState()) {
  const ctx = context();
  let state = initialState;
  const events: ReturnType<typeof mapToolFrame>["events"] = [];
  for (const frame of frames) {
    const mapped = mapToolFrame(ctx, frame, state);
    state = mapped.state;
    events.push(...mapped.events);
  }
  return { state, events };
}

function data(event: ReturnType<typeof run>["events"][number]): Record<string, unknown> {
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return {};
  }
  return event.payload.data as Record<string, unknown>;
}

const bashStart = (toolCallId: string) => ({
  type: "tool_execution_start",
  toolCallId,
  toolName: "bash",
  args: { command: "printf output" },
});
const bashUpdate = (toolCallId: string, text: string) => ({
  type: "tool_execution_update",
  toolCallId,
  toolName: "bash",
  args: { command: "printf output" },
  partialResult: { content: [{ type: "text", text }], details: {} },
});

describe("NeoPi tool mapper", () => {
  it("emits only the new bash output and replaces rolled-over tail windows", () => {
    const { events } = run([
      bashStart("bash-1"),
      ...["a", "ab", "abc", "abcde", "bcdef"].map((text) => bashUpdate("bash-1", text)),
    ]);
    expect(
      events.filter((event) => event.type === "content.delta").map((event) => event.payload.delta),
    ).toEqual(["a", "b", "c", "de"]);
    const replacement = events.filter((event) => event.type === "item.updated");
    expect(replacement).toHaveLength(1);
    expect(replacement[0]?.payload.detail).toBe("bcdef");
    expect(events[0]).toMatchObject({
      type: "item.started",
      payload: { itemType: "command_execution", data: { command: "printf output" } },
    });
  });

  it("emits a split multi-byte code point once, with no invalid surrogate", () => {
    const { events } = run([
      bashStart("bash-1"),
      bashUpdate("bash-1", "a\ud83d"),
      bashUpdate("bash-1", "a\ud83d\ude00"),
    ]);
    const deltas = events
      .filter((event) => event.type === "content.delta")
      .map((event) => event.payload.delta);
    expect(deltas).toEqual(["a", "😀"]);
    expect(deltas.join("")).toBe("a😀");
  });

  it("keeps snapshots isolated for interleaved command calls", () => {
    const { events } = run([
      bashStart("one"),
      bashStart("two"),
      bashUpdate("one", "first"),
      bashUpdate("two", "second"),
      bashUpdate("one", "first!"),
      bashUpdate("two", "second!"),
    ]);
    expect(
      events
        .filter((event) => event.type === "content.delta")
        .map((event) => [event.itemId, event.payload.delta]),
    ).toEqual([
      [scopedItemId(context(), "one"), "first"],
      [scopedItemId(context(), "two"), "second"],
      [scopedItemId(context(), "one"), "!"],
      [scopedItemId(context(), "two"), "!"],
    ]);
  });

  it("preserves both changed paths and diffs from a multi-file edit", () => {
    const start = {
      type: "tool_execution_start",
      toolCallId: "edit-1",
      toolName: "edit",
      args: { path: "src/a.ts" },
    };
    const end = {
      type: "tool_execution_end",
      toolCallId: "edit-1",
      toolName: "edit",
      result: {
        content: [{ type: "text", text: "Edited two files" }],
        details: {
          perFileResults: [
            { path: "src/a.ts", diff: "--- a/src/a.ts\n+++ b/src/a.ts" },
            { path: "src/b.ts", diff: "--- a/src/b.ts\n+++ b/src/b.ts" },
          ],
        },
      },
    };
    const { events } = run([start, end]);
    expect(events.map((event) => event.type)).toEqual(["item.started", "item.completed"]);
    const started = events[0];
    expect(started?.type).toBe("item.started");
    if (started?.type === "item.started") {
      expect(started.payload.itemType).toBe("file_change");
    }
    expect(data(events[1]!)).toMatchObject({
      paths: ["src/a.ts", "src/b.ts"],
      diff: "--- a/src/a.ts\n+++ b/src/a.ts\n--- a/src/b.ts\n+++ b/src/b.ts",
      content: "Edited two files",
    });
  });

  it("marks failed results and exposes image content with its MIME type", () => {
    const { events } = run([
      { type: "tool_execution_start", toolCallId: "image-1", toolName: "view", args: {} },
      {
        type: "tool_execution_end",
        toolCallId: "image-1",
        toolName: "view",
        result: {
          isError: true,
          content: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
        },
      },
    ]);
    expect(events[1]).toMatchObject({
      type: "item.completed",
      payload: { status: "failed", data: { images: [{ mimeType: "image/png", data: "cG5n" }] } },
    });
  });

  it("keeps written content from args and never invents a write diff", () => {
    const { events } = run([
      {
        type: "tool_execution_start",
        toolCallId: "write-1",
        toolName: "write",
        args: { path: "new.ts", content: "const x = 1;" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "write-1",
        toolName: "write",
        result: {
          content: [{ type: "text", text: "Written successfully" }],
          details: { diff: "+const x = 1;" },
        },
      },
    ]);
    expect(data(events[1]!)).toMatchObject({ content: "const x = 1;", paths: ["new.ts"] });
    expect(data(events[1]!)).not.toHaveProperty("diff");
  });

  it("preserves empty written files rather than substituting the success message", () => {
    const { events } = run([
      {
        type: "tool_execution_start",
        toolCallId: "empty-1",
        toolName: "write",
        args: { path: "empty.ts", content: "" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "empty-1",
        toolName: "write",
        result: { content: [{ type: "text", text: "Written" }] },
      },
    ]);
    expect(data(events[1]!).content).toBe("");
  });

  it("deduplicates the host bridge frame against one lifecycle item", () => {
    const start = {
      type: "tool_execution_start",
      toolCallId: "host-1",
      toolName: "link_pull_request",
      args: { id: 1 },
    };
    const host = {
      type: "host_tool_call",
      toolCallId: "host-1",
      toolName: "link_pull_request",
      args: { id: 1 },
    };
    const end = {
      type: "tool_execution_end",
      toolCallId: "host-1",
      toolName: "link_pull_request",
      result: { content: [{ type: "text", text: "linked" }] },
    };
    const { state, events } = run(
      [host, start, end, end],
      withHostToolNames(emptyToolState(), ["link_pull_request"]),
    );
    expect(events.map((event) => event.type)).toEqual(["item.started", "item.completed"]);
    expect(events.map((event) => event.itemId)).toEqual([
      scopedItemId(context(), "host-1"),
      scopedItemId(context(), "host-1"),
    ]);
    expect(events[0]?.payload).toMatchObject({
      itemType: "mcp_tool_call",
      toolSource: { key: "t3-code" },
    });
    expect(state.inFlightTools).toEqual({});
  });

  it("recognizes a late host frame without starting another item", () => {
    const { events } = run([
      {
        type: "tool_execution_start",
        toolCallId: "late-1",
        toolName: "preview_snapshot",
        args: {},
      },
      { type: "host_tool_call", toolCallId: "late-1", toolName: "preview_snapshot" },
      {
        type: "tool_execution_end",
        toolCallId: "late-1",
        toolName: "preview_snapshot",
        result: { content: [] },
      },
    ]);
    expect(events.map((event) => event.type)).toEqual(["item.started", "item.completed"]);
    expect(new Set(events.map((event) => event.itemId))).toEqual(
      new Set([scopedItemId(context(), "late-1")]),
    );
    expect(events[1]?.payload).toMatchObject({
      itemType: "mcp_tool_call",
      toolSource: { key: "t3-code" },
    });
  });
});
