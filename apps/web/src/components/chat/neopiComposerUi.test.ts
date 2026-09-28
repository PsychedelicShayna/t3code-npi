import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { composerCapabilitiesForProvider, projectNeoPiComposerUi } from "./neopiComposerUi";

const activity = (id: string, ui: Record<string, unknown>): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "info",
  kind: "runtime.warning",
  summary: "NeoPi update",
  payload: { detail: { neopiUi: ui } },
  turnId: null,
  createdAt: "2026-09-27T00:00:00.000Z",
});

describe("NeoPi extension composer activity projection", () => {
  it("replaces and clears statuses/widgets by key and preserves the latest chat mode/editor event", () => {
    expect(
      projectNeoPiComposerUi([
        activity("a", { kind: "status", key: "job", text: "running" }),
        activity("b", { kind: "status", key: "other", text: "waiting" }),
        activity("c", { kind: "widget", key: "progress", lines: ["Step 1", "2 / 3"] }),
        activity("d", { kind: "status", key: "job", text: "" }),
        activity("e", { kind: "widget", key: "progress", lines: [] }),
        activity("f", { kind: "chat-mode", mode: "erp" }),
        activity("plan", { kind: "plan-mode", mode: "default" }),
        activity("g", { kind: "editor", text: "suggestion" }),
      ]),
    ).toEqual({
      chatMode: "erp",
      nativePlanMode: "default",
      labels: ["waiting"],
      editor: { eventId: "g", text: "suggestion" },
    });
  });

  it("consumes fresh editor actions once across target switches and composer remounts", () => {
    const provider = composerCapabilitiesForProvider("neopi")!;
    const target = "neopi-editor-regression-thread";
    const other = "neopi-editor-regression-other";
    const project = (events: OrchestrationThreadActivity[]) => provider.project(events).editor;
    expect(
      provider.consumeEditor(target, project([activity("old", { kind: "editor", text: "X" })]), ""),
    ).toBeNull();
    expect(
      provider.consumeEditor(target, project([activity("new", { kind: "editor", text: "Y" })]), ""),
    ).toBe("Y");
    expect(provider.consumeEditor(other, null, "")).toBeNull();
    expect(
      provider.consumeEditor(target, project([activity("new", { kind: "editor", text: "Y" })]), ""),
    ).toBeNull();
    expect(
      provider.consumeEditor(
        target,
        project([activity("later", { kind: "editor", text: "Z" })]),
        "my draft",
      ),
    ).toBeNull();
    expect(
      provider.consumeEditor(
        target,
        project([activity("later", { kind: "editor", text: "Z" })]),
        "",
      ),
    ).toBeNull();
    expect(
      provider.project([activity("mode", { kind: "chat-mode", mode: "erp" })]).displayState,
    ).toBe("Chat: erp");
    expect(
      provider.project([
        activity("chat", { kind: "chat-mode", mode: "off" }),
        activity("entered", { kind: "plan-mode", mode: "plan" }),
        activity("branched", { kind: "plan-mode", mode: "default" }),
      ]).displayState,
    ).toBe("Chat: off · Native: Build");
    expect(provider.commandSourceLabel("mcp_prompt")).toBe(" · MCP prompt");
    expect(provider.skillReplacement("review")).toBe("/skill:review ");
    expect(composerCapabilitiesForProvider("codex")).toBeUndefined();
    expect(composerCapabilitiesForProvider("claudeAgent")).toBeUndefined();
  });
});
