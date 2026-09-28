import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export interface NeoPiComposerUi {
  readonly chatMode: "off" | "chat" | "erp" | "raw" | null;
  readonly labels: ReadonlyArray<string>;
  readonly editor: { readonly eventId: string; readonly text: string } | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Persisted runtime activities survive reconnects; the newest key update wins. */
export function projectNeoPiComposerUi(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): NeoPiComposerUi {
  const status = new Map<string, string>();
  const widgets = new Map<string, string>();
  let chatMode: NeoPiComposerUi["chatMode"] = null;
  let editor: NeoPiComposerUi["editor"] = null;
  for (const activity of activities) {
    if (activity.kind !== "runtime.warning") continue;
    const detail = record(record(activity.payload)?.detail);
    const ui = record(detail?.neopiUi);
    if (!ui) continue;
    if (
      ui.kind === "chat-mode" &&
      (ui.mode === "off" || ui.mode === "chat" || ui.mode === "erp" || ui.mode === "raw")
    )
      chatMode = ui.mode;
    if (ui.kind === "editor" && typeof ui.text === "string")
      editor = { eventId: activity.id, text: ui.text };
    if ((ui.kind === "status" || ui.kind === "widget") && typeof ui.key === "string") {
      const value =
        ui.kind === "status"
          ? ui.text
          : Array.isArray(ui.lines)
            ? ui.lines.filter((line): line is string => typeof line === "string").join(" · ")
            : "";
      const destination = ui.kind === "status" ? status : widgets;
      if (typeof value === "string" && value.length > 0) destination.set(ui.key, value);
      else destination.delete(ui.key);
    }
  }
  return { chatMode, editor, labels: [...status.values(), ...widgets.values()] };
}

// Persist acknowledgement for the lifetime of the loaded app, not the composer
// component: navigation and provider switches must not replay old activities.
const acknowledgedEditorByTarget = new Map<string, string | null>();

export function consumeNeoPiEditorAction(
  target: string,
  editor: NeoPiComposerUi["editor"],
  prompt: string,
): string | null {
  if (!acknowledgedEditorByTarget.has(target)) {
    acknowledgedEditorByTarget.set(target, editor?.eventId ?? null);
    return null; // Existing persisted activities predate this consumer.
  }
  if (!editor || acknowledgedEditorByTarget.get(target) === editor.eventId) return null;
  acknowledgedEditorByTarget.set(target, editor.eventId);
  return prompt.length === 0 ? editor.text : null;
}

/** Provider-owned registrations; absent providers retain upstream composer behavior. */
export const composerProviderCapabilities = {
  neopi: {
    project: (activities: ReadonlyArray<OrchestrationThreadActivity>) => {
      const ui = projectNeoPiComposerUi(activities);
      return {
        editor: ui.editor,
        displayState: [ui.chatMode ? `Chat: ${ui.chatMode}` : "", ...ui.labels]
          .filter(Boolean)
          .join(" · "),
      };
    },
    consumeEditor: consumeNeoPiEditorAction,
    commandSourceLabel: (source: string | undefined) =>
      source ? ` · ${source === "mcp_prompt" ? "MCP prompt" : source}` : "",
    skillReplacement: (name: string) => `/skill:${name} `,
  },
} as const;

export function composerCapabilitiesForProvider(provider: string) {
  return provider === "neopi" ? composerProviderCapabilities.neopi : undefined;
}
