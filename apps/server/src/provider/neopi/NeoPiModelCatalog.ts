import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

type RpcModel = Record<string, unknown>;
const asRecord = (value: unknown): RpcModel | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RpcModel) : null;
const modelSlug = (model: RpcModel | null): string | null =>
  model &&
  typeof model.provider === "string" &&
  model.provider &&
  typeof model.id === "string" &&
  model.id
    ? `${model.provider}/${model.id}`
    : null;

/** The native catalog defines each model's effort ladder; never invent unsupported levels. */
export function toServerProviderModels(
  models: ReadonlyArray<unknown>,
  current?: unknown,
  fastModeEnabled = false,
): ReadonlyArray<ServerProviderModel> {
  const currentRecord = asRecord(current);
  const currentSlug = modelSlug(currentRecord);
  const available = models.flatMap((entry): ServerProviderModel[] => {
    const model = asRecord(entry);
    const slug = modelSlug(model);
    if (!model || !slug) return [];
    const thinking = asRecord(model.thinking);
    const efforts =
      thinking && Array.isArray(thinking.efforts)
        ? thinking.efforts.filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          )
        : [];
    const defaultLevel = thinking?.defaultLevel;
    return [
      {
        slug,
        name: typeof model.name === "string" && model.name ? model.name : (model.id as string),
        shortName: model.id as string,
        subProvider: model.provider as string,
        isCustom: false,
        ...(currentSlug === slug ? { isDefault: true } : {}),
        capabilities: createModelCapabilities({
          optionDescriptors: [
            ...(efforts.length
              ? [
                  {
                    id: "reasoningEffort",
                    type: "select" as const,
                    label: "Thinking",
                    options: efforts.map((level) => ({
                      id: level,
                      label: level.charAt(0).toUpperCase() + level.slice(1),
                      ...(level === defaultLevel ? { isDefault: true } : {}),
                    })),
                    ...(typeof defaultLevel === "string" && efforts.includes(defaultLevel)
                      ? { currentValue: defaultLevel }
                      : {}),
                  },
                ]
              : []),
            {
              id: "fastMode",
              type: "boolean" as const,
              label: "Fast mode",
              currentValue: currentSlug === slug && fastModeEnabled,
            },
          ],
        }),
      },
    ];
  });
  if (currentSlug && !available.some((model) => model.slug === currentSlug)) {
    const missing = toServerProviderModels([current], current, fastModeEnabled)[0];
    if (missing) return [...available, { ...missing, isCustom: true }];
  }
  return available;
}
