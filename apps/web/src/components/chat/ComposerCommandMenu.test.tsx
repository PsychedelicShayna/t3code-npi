import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ComposerCommandMenu } from "./ComposerCommandMenu";

describe("ComposerCommandMenu", () => {
  it("renders slash commands with their descriptions", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "slash:model",
            type: "slash-command",
            command: "model",
            label: "/model",
            description: "Switch response model for this thread",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="slash:model"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("/model");
    expect(markup).toContain("Switch response model for this thread");
  });

  it("shows the app source for an app skill", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "skill:codex:browser",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "browser",
              path: "/Users/maria/.codex/plugins/browser/skills/browser/SKILL.md",
              scope: "user",
              enabled: true,
            },
            label: "Browser",
            description: "Open and control the in-app browser",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="skill"
        activeItemId="skill:codex:browser"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("Browser");
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain(">App Skill</span>");
    expect(markup).toContain("Open and control the in-app browser");
    expect(markup).toContain("<svg");
  });

  it("shows the repo source for a slash skill", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "skill:codex:ask-matt",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "ask-matt",
              displayName: "Ask Matt",
              path: "/skills/ask-matt/SKILL.md",
              scope: "repo",
              enabled: true,
            },
            label: "/skill:ask-matt",
            description: "Find the right skill or workflow",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="skill:codex:ask-matt"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain('<span class="text-secondary-label">/skill:</span>Ask Matt');
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain("lucide-folder");
    expect(markup).toContain(">Repo</span>");
    expect(markup).toContain("Find the right skill or workflow");
  });

  it("renders NeoPi commands and skills in their respective menus", () => {
    const slash = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "provider-slash-command:neopi:review",
            type: "provider-slash-command",
            provider: ProviderDriverKind.make("neopi"),
            command: {
              name: "review",
              description: "Review files",
              input: { hint: "path" },
              source: "extension",
            },
            label: "/review",
            description: "Review files · extension",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="provider-slash-command:neopi:review"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );
    const skills = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "skill:neopi:unslop",
            type: "skill",
            provider: ProviderDriverKind.make("neopi"),
            skill: {
              name: "unslop",
              path: "neopi:skill/unslop",
              scope: "user",
              enabled: true,
              userInvocable: true,
            },
            label: "Unslop",
            description: "Remove slop",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="skill"
        activeItemId="skill:neopi:unslop"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(slash).toContain("/review");
    expect(slash).toContain("Review files · extension");
    expect(skills).toContain("Unslop");
    expect(skills).toContain("Personal Skill");
  });
});
