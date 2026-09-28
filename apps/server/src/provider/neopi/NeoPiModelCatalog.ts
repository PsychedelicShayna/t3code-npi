import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import type { GetRolesResult, NeoPiRole } from "effect-neopi-rpc/schema";
import { isRecord } from "effect-neopi-rpc/schema";

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

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const isResolvedRole = (value: unknown): boolean => {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    typeof value.modelId === "string" &&
    value.modelId.length > 0 &&
    isOptionalString(value.thinkingLevel)
  );
};

const isNeoPiRole = (value: unknown): value is NeoPiRole => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.alias === "string" &&
    value.alias.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    isOptionalString(value.tag) &&
    isOptionalString(value.section) &&
    (value.source === "builtin" || value.source === "configured") &&
    isOptionalString(value.configured) &&
    Array.isArray(value.patterns) &&
    value.patterns.every((pattern) => typeof pattern === "string") &&
    isResolvedRole(value.resolved) &&
    typeof value.hidden === "boolean"
  );
};

export function neoPiRolesFromRpc(data: unknown): GetRolesResult | undefined {
  if (!isRecord(data) || !Array.isArray(data.roles) || !data.roles.every(isNeoPiRole))
    return undefined;
  if (data.activeRole !== undefined && typeof data.activeRole !== "string") return undefined;
  return { roles: data.roles, ...(data.activeRole ? { activeRole: data.activeRole } : {}) };
}

/** Role aliases are deliberately disjoint from native `provider/model` slugs. */
export function neoPiRoleFromModelSlug(slug: string): string | undefined {
  if (!slug.startsWith("@") || slug.length === 1 || slug.includes("/")) return undefined;
  return slug.slice(1);
}

function toServerProviderRoleModels(
  result: GetRolesResult,
  fastModeEnabled: boolean,
): ReadonlyArray<ServerProviderModel> {
  return result.roles.flatMap((role): ServerProviderModel[] => {
    if (role.hidden === true) return [];
    const slug = `@${role.id}`;
    return [
      {
        slug,
        name: role.name,
        shortName: role.tag || role.id,
        subProvider: "Roles",
        aliases: slug === role.alias ? [role.id] : [role.id, role.alias],
        isCustom: false,
        ...(result.activeRole === role.id ? { isDefault: true } : {}),
        capabilities: createModelCapabilities({
          optionDescriptors: [
            {
              id: "fastMode",
              type: "boolean",
              label: "Fast mode",
              currentValue: result.activeRole === role.id && fastModeEnabled,
            },
          ],
        }),
      },
    ];
  });
}

/** The native catalog defines each model's effort ladder; never invent unsupported levels. */
export function toServerProviderModels(
  models: ReadonlyArray<unknown>,
  current?: unknown,
  fastModeEnabled = false,
  roleResult?: GetRolesResult,
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
        ...(currentSlug === slug && !roleResult?.activeRole ? { isDefault: true } : {}),
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
  const withCurrent =
    currentSlug && !available.some((model) => model.slug === currentSlug)
      ? (() => {
          const missing = toServerProviderModels([current], current, fastModeEnabled)[0];
          if (!missing) return available;
          const custom = { ...missing, isCustom: true };
          if (roleResult?.activeRole) delete custom.isDefault;
          return [...available, custom];
        })()
      : available;
  if (!roleResult) return withCurrent;
  return [...toServerProviderRoleModels(roleResult, fastModeEnabled), ...withCurrent];
}
