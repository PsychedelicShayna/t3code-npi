import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { emptyUiState, flushUiSettlements, mapUiRequest, NEOPI_CAP_TOOL_APPROVAL } from "./ui.ts";

const ctx = {
  provider: ProviderDriverKind.make("neopi"),
  providerInstanceId: ProviderInstanceId.make("neopi-default"),
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  now: () => "2026-09-27T00:00:00.000Z",
  newEventId: (() => {
    let next = 0;
    return () => `ui-${++next}`;
  })(),
};
const decode = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const approval = (id: string) => ({
  type: "extension_ui_request",
  method: "select",
  id,
  title: "Allow tool: bash\nReason: destructive command\nCommand: rm -rf build",
  options: ["Approve", "Deny"],
});

function send(state: ReturnType<typeof emptyUiState>, frame: unknown) {
  const result = mapUiRequest(ctx, frame, state);
  result.events.forEach((event) => decode(event));
  return result;
}

describe("NeoPi UI mapper", () => {
  it("converts a legacy approval, retaining prompt details and restricting options", () => {
    const state = emptyUiState();
    const result = send(state, { ...approval("a"), timeout: 1234 });
    expect(result.events[0]).toMatchObject({
      type: "request.opened",
      requestId: "a",
      payload: {
        requestType: "exec_command_approval",
        detail:
          "Allow tool: bash\nReason: destructive command\nCommand: rm -rf build\nTimeout: 1234ms",
        options: [
          { decision: "accept", label: "Approve" },
          { decision: "decline", label: "Deny" },
        ],
      },
      raw: { source: "neopi.rpc" },
    });
    expect(result.pending?.reply("acceptForSession")).toEqual({
      _tag: "ExtensionUi",
      frame: { id: "a", value: "Approve" },
    });
    expect(flushUiSettlements(ctx, state).map((event) => decode(event))).toMatchObject([
      { type: "request.resolved", requestId: "a", payload: { decision: "acceptForSession" } },
    ]);
    expect(send(state, { ...approval("b") }).pending?.reply("decline")).toEqual({
      _tag: "ExtensionUi",
      frame: { id: "b", value: "Deny" },
    });
  });

  it("keeps a similarly worded non-approval select as user input", () => {
    const state = emptyUiState();
    const result = send(state, {
      type: "extension_ui_request",
      id: "choice",
      method: "select",
      title: "Would you allow tool: bash?",
      options: ["Approve", "Deny"],
    });
    expect(result.events).toMatchObject([{ type: "user-input.requested", requestId: "choice" }]);
    expect(result.pending?.kind).toBe("user-input");
  });

  it("does not guess an item when more than one matching tool is running", () => {
    const state = emptyUiState();
    send(state, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "first" },
    });
    send(state, {
      type: "tool_execution_start",
      toolCallId: "tool-2",
      toolName: "bash",
      args: { command: "second" },
    });
    const ambiguous = send(state, approval("a")).events[0];
    expect(ambiguous).not.toHaveProperty("itemId");
    expect(ambiguous?.payload).not.toHaveProperty("args");
    send(state, { type: "tool_execution_end", toolCallId: "tool-2" });
    const unique = send(state, approval("b")).events[0];
    expect(unique).toMatchObject({ itemId: "tool-1", payload: { args: { command: "first" } } });
  });

  it("gates structured approval on ready capabilities and sends its dedicated response", () => {
    const state = emptyUiState();
    const frame = {
      type: "tool_approval_request",
      id: "structured",
      toolCallId: "tool-3",
      toolName: "bash",
      args: { command: "rm build" },
      reason: "danger",
      details: ["Command: rm build"],
    };
    expect(send(state, frame).events).toEqual([]);
    send(state, { type: "ready", capabilities: [NEOPI_CAP_TOOL_APPROVAL] });
    const result = send(state, frame);
    expect(result.events[0]).toMatchObject({
      type: "request.opened",
      itemId: "tool-3",
      payload: {
        requestType: "exec_command_approval",
        args: { command: "rm build" },
        detail: "Allow tool: bash\nReason: danger\nCommand: rm build",
        options: [
          { decision: "accept" },
          { decision: "acceptForSession" },
          { decision: "decline" },
        ],
      },
    });
    expect(result.pending?.reply("acceptForSession")).toEqual({
      _tag: "ToolApproval",
      frame: { type: "tool_approval_response", id: "structured", decision: "allow_session" },
    });
    expect(flushUiSettlements(ctx, state).map((event) => decode(event))).toMatchObject([
      { type: "request.resolved", requestId: "structured" },
    ]);
  });

  it("maps an ask select, editor and next select into successive questions with verbatim answers", () => {
    const state = emptyUiState();
    const first = send(state, {
      type: "extension_ui_request",
      id: "q1",
      method: "select",
      title: "Which file?",
      options: ["src/foo", "Other (type your own)"],
    });
    expect(first.events[0]).toMatchObject({
      type: "user-input.requested",
      payload: {
        questions: [
          {
            id: "q1",
            header: "Which file?",
            allowCustomAnswer: false,
            multiSelect: false,
            options: [
              { label: "src/foo", description: "", value: "src/foo" },
              { label: "Other (type your own)", description: "", value: "Other (type your own)" },
            ],
          },
        ],
      },
    });
    expect(first.pending?.reply({ q1: "Other (type your own)" })).toEqual({
      _tag: "ExtensionUi",
      frame: { id: "q1", value: "Other (type your own)" },
    });
    const editor = send(state, {
      type: "extension_ui_request",
      id: "q2",
      method: "editor",
      title: "Enter path",
      prefill: "src/default path",
    });
    expect(editor.events.map((event) => event.type)).toEqual([
      "user-input.resolved",
      "user-input.requested",
    ]);
    expect(editor.events[1]).toMatchObject({
      payload: {
        questions: [{ options: [{ value: "src/default path" }], allowCustomAnswer: true }],
      },
    });
    expect(editor.pending?.reply({ q2: "src/foo/bar baz" })).toEqual({
      _tag: "ExtensionUi",
      frame: { id: "q2", value: "src/foo/bar baz" },
    });
    const next = send(state, {
      type: "extension_ui_request",
      id: "q3",
      method: "select",
      title: "Continue?",
      options: ["Yes", "No"],
      optionDetails: [{ description: "proceed" }, { description: "stop" }],
    });
    expect(next.events.map((event) => event.type)).toEqual([
      "user-input.resolved",
      "user-input.requested",
    ]);
    expect(next.events[0]).toMatchObject({ payload: { answers: { q2: "src/foo/bar baz" } } });
    expect(next.events[1]).toMatchObject({
      payload: {
        questions: [
          {
            options: [
              { label: "Yes", description: "proceed" },
              { label: "No", description: "stop" },
            ],
          },
        ],
      },
    });
  });

  it("resolves only a targeted cancel; unknown and repeated targets warn", () => {
    const state = emptyUiState();
    send(state, approval("a"));
    send(state, { type: "extension_ui_request", id: "b", method: "input", title: "Value" });
    expect(
      send(state, {
        type: "extension_ui_request",
        id: "c",
        method: "cancel",
        targetId: "missing",
      }).events.map((event) => event.type),
    ).toEqual(["runtime.warning"]);
    const cancelled = send(state, { type: "tool_approval_cancel", id: "d", targetId: "a" });
    expect(cancelled.events).toMatchObject([
      {
        type: "request.resolved",
        requestId: "a",
        payload: { resolution: "cancelled", decision: "cancel" },
      },
    ]);
    expect(state.open.has("b")).toBe(true);
    expect(
      send(state, { type: "extension_ui_request", id: "e", method: "cancel", targetId: "b" })
        .events,
    ).toMatchObject([
      {
        type: "user-input.resolved",
        requestId: "b",
        payload: { answers: { resolution: "cancelled" } },
      },
    ]);
    expect(
      send(state, {
        type: "extension_ui_request",
        id: "f",
        method: "cancel",
        targetId: "b",
      }).events.map((event) => event.type),
    ).toEqual(["runtime.warning"]);
  });

  it("maps confirm, input and extension notices without pending replies for notices", () => {
    const state = emptyUiState();
    const confirm = send(state, {
      type: "extension_ui_request",
      id: "c",
      method: "confirm",
      title: "Proceed?",
      message: "Launch task?",
      timeout: 500,
    });
    expect(confirm.events[0]).toMatchObject({
      payload: { questions: [{ question: "Launch task?\nTimeout: 500ms" }] },
    });
    expect(confirm.pending?.reply({ c: true })).toEqual({
      _tag: "ExtensionUi",
      frame: { id: "c", confirmed: true },
    });
    const notices = [
      [
        { method: "notify", message: "hello", notifyType: "info" },
        "thread.metadata.updated",
        { metadata: { notice: "hello" } },
      ],
      [
        { method: "notify", message: "careful", notifyType: "warning" },
        "runtime.warning",
        { message: "careful" },
      ],
      [
        { method: "setStatus", statusKey: "job", statusText: "running" },
        "thread.metadata.updated",
        { metadata: { status: { key: "job", text: "running" } } },
      ],
      [
        {
          method: "setWidget",
          widgetKey: "review",
          widgetLines: ["line"],
          widgetPlacement: "belowEditor",
        },
        "thread.metadata.updated",
        { metadata: { widget: { key: "review", lines: ["line"], placement: "belowEditor" } } },
      ],
      [
        { method: "set_editor_text", text: "draft" },
        "thread.metadata.updated",
        { metadata: { composerText: "draft" } },
      ],
      [
        {
          method: "open_url",
          url: "https://example.com/long",
          launchUrl: "http://localhost/go",
          instructions: "Sign in",
        },
        "runtime.warning",
        {
          message: "Sign in",
          detail: { url: "https://example.com/long", launchUrl: "http://localhost/go" },
        },
      ],
      [{ method: "setTitle", title: "Working" }, "thread.metadata.updated", { name: "Working" }],
    ] as const;
    for (const [request, type, payload] of notices) {
      const result = send(state, {
        type: "extension_ui_request",
        id: `notice-${request.method}`,
        ...request,
      });
      expect(result.pending).toBeUndefined();
      expect(result.events.at(-1)).toMatchObject({ type, payload });
    }
  });
});
