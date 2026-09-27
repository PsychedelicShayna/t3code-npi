import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { projectNeoPiComposerUi } from "./neopiComposerUi";

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
        activity("g", { kind: "editor", text: "suggestion" }),
      ]),
    ).toEqual({
      chatMode: "erp",
      labels: ["waiting"],
      editor: { eventId: "g", text: "suggestion" },
    });
  });
});
