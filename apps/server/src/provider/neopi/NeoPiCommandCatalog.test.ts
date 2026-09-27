import { describe, expect, it } from "vite-plus/test";
import { toNeoPiCommandCatalog } from "./NeoPiCommandCatalog.ts";
import { NEOPI_CAPABILITIES } from "./NeoPiCompatibility.ts";

describe("NeoPi command catalog", () => {
  const commands = [
    { name: "new", source: "builtin", description: "New session" },
    { name: "quit", source: "builtin" },
    { name: "compact", source: "builtin" },
    { name: "review", source: "extension", description: "Review files", input: { hint: "path" } },
    {
      name: "skill:unslop",
      source: "skill",
      description: "Remove slop",
      input: { hint: "arguments" },
    },
  ];
  it("retains native inputs, filters session mutation and publishes skills separately", () => {
    expect(toNeoPiCommandCatalog(commands)).toEqual({
      slashCommands: [
        {
          name: "review",
          description: "Review files",
          input: { hint: "path" },
          source: "extension",
        },
      ],
      skills: [
        {
          name: "unslop",
          description: "Remove slop",
          path: "neopi:skill/unslop",
          scope: "user",
          enabled: true,
          userInvocable: true,
        },
      ],
    });
  });
  it("places chat first only when supported or explicitly listed by the peer", () => {
    expect(
      toNeoPiCommandCatalog(commands).slashCommands.some((command) => command.name === "chat"),
    ).toBe(false);
    expect(
      toNeoPiCommandCatalog([{ name: "chat", source: "builtin" }, ...commands]).slashCommands[0]
        ?.name,
    ).toBe("chat");
    expect(
      toNeoPiCommandCatalog(commands, new Set([NEOPI_CAPABILITIES.setChatMode])).slashCommands[0],
    ).toMatchObject({ name: "chat", input: { hint: "chat|erp|raw|off" } });
  });
});
