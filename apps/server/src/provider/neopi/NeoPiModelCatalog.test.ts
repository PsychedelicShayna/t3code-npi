import { expect, it } from "vite-plus/test";
import { toServerProviderModels } from "./NeoPiModelCatalog.ts";

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
