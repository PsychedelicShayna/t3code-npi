import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import { NEOPI_CAPABILITIES } from "./NeoPiCompatibility.ts";

export interface NeoPiAvailableCommand {
  readonly name: string;
  readonly description?: string;
  readonly input?: { readonly hint?: string };
  readonly source?: string;
}

// NeoPi builtin-lifecycle.ts, builtin-session.ts and builtin-modes.ts: these
// change session identity/context (or exit the TUI); T3 owns that lifecycle.
const SESSION_COMMANDS = new Set([
  "new",
  "clear",
  "delete",
  "switch",
  "resume",
  "session",
  "branch",
  "tree",
  "fork",
  "quit",
  "exit",
]);

export function toNeoPiCommandCatalog(
  commands: ReadonlyArray<NeoPiAvailableCommand>,
  capabilities: ReadonlySet<string> = new Set(),
): { slashCommands: ServerProviderSlashCommand[]; skills: ServerProviderSkill[] } {
  const slashCommands: ServerProviderSlashCommand[] = [];
  const skills: ServerProviderSkill[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    const name = command.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const description = command.description?.trim() || undefined;
    if (command.source === "skill") {
      const skillName = name.startsWith("skill:") ? name.slice(6) : name;
      if (skillName)
        skills.push({
          name: skillName,
          ...(description ? { description } : {}),
          path: `neopi:skill/${skillName}`,
          scope: "user",
          enabled: true,
          userInvocable: true,
        });
      continue;
    }
    if (
      name === "compact" ||
      name === "quit" ||
      name === "exit" ||
      name === "model" ||
      (command.source === "builtin" && SESSION_COMMANDS.has(name))
    )
      continue;
    const hint = command.input?.hint?.trim();
    const source = command.source;
    slashCommands.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
      ...(source === "builtin" ||
      source === "extension" ||
      source === "custom" ||
      source === "mcp_prompt" ||
      source === "file"
        ? { source }
        : {}),
    });
  }
  if (capabilities.has(NEOPI_CAPABILITIES.setChatMode)) {
    const chat = slashCommands.find((command) => command.name === "chat");
    return {
      slashCommands: [
        chat ?? {
          name: "chat",
          description: "Switch NeoPi/OMP chat mode",
          input: { hint: "chat|erp|raw|off" },
          source: "builtin",
        },
        ...slashCommands.filter((command) => command.name !== "chat"),
      ],
      skills,
    };
  }
  return { slashCommands, skills };
}
