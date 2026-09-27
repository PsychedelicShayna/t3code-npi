import { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectActivityPayload } from "../../../orchestration/ActivityPayloadProjection.ts";
import { runtimeEventToActivities } from "../../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import {
  extractCommandOutputText,
  resolveViewedImageAsset,
  toolGroupAction,
  workEntryViewedImagePath,
} from "../../../../../../packages/client-runtime/src/work-log/presentation.ts";

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
  it("publishes each bash window, replacing a rolled-over tail instead of appending it", () => {
    const { events } = run([
      bashStart("bash-1"),
      ...["a", "ab", "abc", "abcde", "bcdef"].map((text) => bashUpdate("bash-1", text)),
    ]);
    expect(events.filter((event) => event.type === "content.delta")).toEqual([]);
    const windows = events.filter((event) => event.type === "item.updated").map(commandWindow);
    expect(windows).toEqual(["a", "ab", "abc", "abcde", "bcdef"]);
    expect(windows.at(-1)).not.toContain("abcde");
    expect(new Set(events.map((event) => event.itemId))).toEqual(
      new Set([scopedItemId(context(), "bash-1")]),
    );
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
    const windows = events.filter((event) => event.type === "item.updated").map(commandWindow);
    expect(windows).toEqual(["a", "a😀"]);
    expect(JSON.stringify(windows)).not.toContain("\\ud83d");
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
        .filter((event) => event.type === "item.updated")
        .map((event) => [event.itemId, commandWindow(event)]),
    ).toEqual([
      [scopedItemId(context(), "one"), "first"],
      [scopedItemId(context(), "two"), "second"],
      [scopedItemId(context(), "one"), "first!"],
      [scopedItemId(context(), "two"), "second!"],
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

function commandWindow(event: ReturnType<typeof run>["events"][number]): string | undefined {
  const item = data(event).item;
  return item && typeof item === "object" && "aggregatedOutput" in item
    ? (item.aggregatedOutput as string)
    : undefined;
}

function bashEnd(toolCallId: string, text: string, exitCode = 0) {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName: "bash",
    args: { command: "printf output" },
    result: {
      content: [{ type: "text", text }],
      details: { exitCode },
    },
  };
}

function surfacedOutput(events: ReturnType<typeof run>["events"]): string[] {
  return events.flatMap((event) =>
    runtimeEventToActivities(event).flatMap((activity) => {
      const projected = projectActivityPayload(activity);
      const payload = projected.payload as { data?: unknown };
      const text = extractCommandOutputText(payload.data);
      return text ? [text] : [];
    }),
  );
}

describe("NeoPi tool output at the T3 consumer boundary", () => {
  it("surfaces prefix growth, rollover, and an authoritative final result", () => {
    const grown = run([
      bashStart("bash-1"),
      ...["a", "ab", "abc", "abcde", "bcdef"].map((text) => bashUpdate("bash-1", text)),
      bashEnd("bash-1", "final line"),
    ]);
    expect(surfacedOutput(grown.events)).toEqual([
      "a",
      "ab",
      "abc",
      "abcde",
      "bcdef",
      "final line",
    ]);
    expect(grown.events.filter((event) => event.type === "item.completed")).toHaveLength(1);

    const finalOnly = run([bashStart("bash-2"), bashEnd("bash-2", "only at the end")]);
    expect(finalOnly.events.map((event) => event.type)).toEqual(["item.started", "item.completed"]);
    expect(surfacedOutput(finalOnly.events)).toEqual(["only at the end"]);
  });

  it("surfaces an edit diff and a viewed image through projection and the work log", () => {
    const imagePath = "/workspace/diagram.png";
    const { events } = run([
      {
        type: "tool_execution_start",
        toolCallId: "edit-1",
        toolName: "edit",
        args: { path: "src/a.ts" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "edit-1",
        toolName: "edit",
        result: {
          content: [{ type: "text", text: "Edited two files" }],
          details: {
            diff: "--- a/src/a.ts\n+++ b/src/a.ts\n+kept",
            perFileResults: [
              { path: "src/a.ts", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n+kept" },
              { path: "src/b.ts", diff: "--- a/src/b.ts\n+++ b/src/b.ts\n+also" },
            ],
          },
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "image-1",
        toolName: "read",
        args: { path: `file://${imagePath}` },
      },
      {
        type: "tool_execution_end",
        toolCallId: "image-1",
        toolName: "read",
        args: { path: `file://${imagePath}` },
        result: {
          content: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
          details: { meta: { source: { type: "path", value: imagePath } } },
        },
      },
    ]);

    const activities = events.flatMap((event) =>
      runtimeEventToActivities(event).map((activity) => projectActivityPayload(activity)),
    );
    const edit = activities.find(
      (activity) =>
        activity.kind === "tool.completed" &&
        (activity.payload as { itemType?: string }).itemType === "file_change",
    );
    const editData = (edit?.payload as { data?: Record<string, unknown> }).data;
    expect(editData?.files).toEqual([{ path: "src/a.ts" }, { path: "src/b.ts" }]);
    expect(extractCommandOutputText(editData)).toBe("--- a/src/a.ts");
    expect(
      toolGroupAction({
        label: "File change",
        tone: "tool",
        itemType: "file_change",
        changedFiles: ["src/a.ts", "src/b.ts"],
      }),
    ).toBe("edit");

    const image = activities.find(
      (activity) => (activity.payload as { itemType?: string }).itemType === "image_view",
    );
    const viewed = (image?.payload as { data?: { imagePath?: string } }).data?.imagePath;
    expect(viewed).toBe(imagePath);
    expect(
      workEntryViewedImagePath({
        label: "Image view",
        tone: "tool",
        itemType: "image_view",
        viewedImagePath: viewed,
      }),
    ).toBe(imagePath);
    expect(
      resolveViewedImageAsset(imagePath, {
        threadId: ThreadId.make("thread-1"),
        workspaceRoot: "/workspace",
      })?.resource._tag,
    ).toBe("media-file");
  });
});
