import { expect, it } from "vite-plus/test";
import {
  neoPiRoleFromModelSlug,
  neoPiRolesFromRpc,
  neoPiUsageProviderId,
  toServerProviderModels,
} from "./NeoPiModelCatalog.ts";

it("preserves each model's actual effort ladder and current default", () => {
  const models = toServerProviderModels(
    [
      {
        provider: "openai",
        id: "gpt/extended",
        name: "GPT",
        thinking: { efforts: ["low", "medium", "high"], defaultLevel: "medium" },
      },
      { provider: "local", id: "basic" },
    ],
    { provider: "openai", id: "gpt/extended" },
  );
  expect(models[0]?.isDefault).toBe(true);
  expect(models[0]?.slug).toBe("openai/gpt/extended");
  expect(models[0]?.capabilities?.optionDescriptors).toEqual([
    {
      id: "reasoningEffort",
      type: "select",
      label: "Thinking",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
    { id: "fastMode", type: "boolean", label: "Fast mode", currentValue: false },
  ]);
  expect(models[1]?.capabilities?.optionDescriptors).toEqual([
    { id: "fastMode", type: "boolean", label: "Fast mode", currentValue: false },
  ]);
});

it("retains a current model absent from a refreshed catalog and reflects active fast mode", () => {
  const models = toServerProviderModels(
    [{ provider: "local", id: "basic" }],
    { provider: "openai", id: "gpt/extended", thinking: { efforts: ["low", "high"] } },
    true,
  );
  expect(models[1]?.isCustom).toBe(true);
  expect(models[1]?.isDefault).toBe(true);
  expect(models[1]?.capabilities?.optionDescriptors).toEqual([
    {
      id: "reasoningEffort",
      type: "select",
      label: "Thinking",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
    { id: "fastMode", type: "boolean", label: "Fast mode", currentValue: true },
  ]);
});

it("adds visible RPC roles as a distinct picker group and selects the active role", () => {
  const roles = neoPiRolesFromRpc({
    roles: [
      {
        id: "smol",
        alias: "@smol",
        name: "Fast",
        tag: "SMOL",
        section: "chat",
        source: "builtin",
        patterns: ["openai/gpt-5.6-luna:low"],
        resolved: {
          provider: "openai",
          modelId: "gpt-5.6-luna",
          thinkingLevel: "low",
        },
        hidden: false,
      },
      {
        id: "private",
        alias: "@private",
        name: "Private",
        section: "chat",
        source: "configured",
        patterns: [],
        hidden: true,
      },
    ],
    activeRole: "smol",
  });
  expect(roles).toBeDefined();
  const models = toServerProviderModels(
    [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna" }],
    { provider: "openai", id: "gpt-5.6-luna" },
    true,
    roles,
  );
  expect(models).toEqual([
    {
      slug: "@smol",
      name: "Fast",
      shortName: "SMOL",
      subProvider: "Roles",
      quotaProvider: "openai",
      aliases: ["smol"],
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          { id: "fastMode", type: "boolean", label: "Fast mode", currentValue: true },
        ],
      },
    },
    {
      slug: "openai/gpt-5.6-luna",
      name: "Luna",
      shortName: "gpt-5.6-luna",
      subProvider: "openai",
      quotaProvider: "openai",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          { id: "fastMode", type: "boolean", label: "Fast mode", currentValue: true },
        ],
      },
    },
  ]);
  expect(neoPiRoleFromModelSlug("@smol")).toBe("smol");
  expect(neoPiRoleFromModelSlug("openai/gpt-5.6-luna")).toBeUndefined();
  expect(neoPiUsageProviderId(models)).toBe("openai");
  expect(models[0]?.subProvider).toBe("Roles");
});

it("does not treat the role picker group as a usage provider", () => {
  const unresolved = toServerProviderModels(
    [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna" }],
    { provider: "openai", id: "gpt-5.6-luna" },
    false,
    neoPiRolesFromRpc({
      roles: [
        {
          id: "smol",
          alias: "@smol",
          name: "Fast",
          source: "builtin",
          patterns: [],
          hidden: false,
        },
      ],
      activeRole: "smol",
    }),
  );
  expect(unresolved[0]?.subProvider).toBe("Roles");
  expect(unresolved[0]?.quotaProvider).toBeUndefined();
  expect(neoPiUsageProviderId(unresolved)).toBe("");
});

it("rejects malformed role catalogs instead of exposing partial picker entries", () => {
  expect(
    neoPiRolesFromRpc({
      roles: [{ id: "smol", alias: "@smol", name: "Fast", source: "builtin" }],
    }),
  ).toBeUndefined();
});
