import type { NeoPiSettings, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import type { NeoPiRpcClient, SpawnFn } from "effect-neopi-rpc/client";
import { make as makeClient } from "effect-neopi-rpc/client";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { providerModelsFromSettings } from "../providerSnapshot.ts";
import type { NeoPiDiscoveryHub } from "../neopi/NeoPiDiscovery.ts";
import type { NeoPiDiscoveryProbe } from "../neopi/NeoPiDiscoveryProbe.ts";
import { NEOPI_CAPABILITIES, neopiCompatibility } from "../neopi/NeoPiCompatibility.ts";
import { neoPiRolesFromRpc, toServerProviderModels } from "../neopi/NeoPiModelCatalog.ts";

const PRESENTATION = {
  displayName: "NeoPi/OMP",
  badgeLabel: "OMP RPC",
  showInteractionModeToggle: false,
  reportsContextWindow: true,
  supportsConversationRollback: true,
} as const;
const fallbackModels = (settings: NeoPiSettings) =>
  providerModelsFromSettings(
    [],
    settings.customModels ?? [],
    createModelCapabilities({ optionDescriptors: [] }),
  );

const fromProbe = (
  settings: NeoPiSettings,
  checkedAt: string,
  input: {
    installed: boolean;
    version?: string | null;
    status: "ready" | "warning" | "error";
    auth?: "unknown" | "authenticated";
    message?: string;
    models?: ReadonlyArray<ServerProviderModel>;
    compatibilityAdvisory?: ReturnType<typeof neopiCompatibility>;
    showInteractionModeToggle?: boolean;
  },
): ServerProviderDraft => ({
  ...buildServerProvider({
    presentation: {
      ...PRESENTATION,
      showInteractionModeToggle: input.showInteractionModeToggle === true,
      reportsContextWindow: input.status === "ready",
    },
    enabled: settings.enabled,
    checkedAt,
    models: input.models ?? fallbackModels(settings),
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: input.installed,
      version: input.version ?? null,
      status: input.status,
      auth: { status: input.auth ?? "unknown" },
      ...(input.message ? { message: input.message } : {}),
    },
  }),
  versionAdvisory: {
    status: "unknown",
    currentVersion: input.version ?? null,
    latestVersion: null,
    updateCommand: "npi update",
    canUpdate: false,
    checkedAt,
    message: "Update NeoPi/OMP manually with the CLI that owns this installation.",
  },
  ...(input.compatibilityAdvisory ? { compatibilityAdvisory: input.compatibilityAdvisory } : {}),
});

export const buildInitialNeoPiProviderSnapshot = (settings: NeoPiSettings) =>
  DateTime.now.pipe(
    Effect.map((now) =>
      fromProbe(
        settings,
        DateTime.formatIso(now),
        settings.enabled
          ? {
              installed: true,
              status: "warning",
              message: "Checking NeoPi/OMP CLI availability...",
            }
          : {
              installed: false,
              status: "warning",
              message: "NeoPi/OMP is disabled in T3 Code settings.",
            },
      ),
    ),
  );

export function modelsFromNeoPiRpc(
  data: unknown,
  current?: unknown,
  fastModeEnabled = false,
  roles?: unknown,
): ReadonlyArray<ServerProviderModel> {
  if (
    typeof data !== "object" ||
    data === null ||
    !("models" in data) ||
    !Array.isArray(data.models)
  )
    return [];
  return toServerProviderModels(data.models, current, fastModeEnabled, neoPiRolesFromRpc(roles));
}

export function requestNeoPiProviderMetadata(
  client: Pick<NeoPiRpcClient, "capabilities" | "request">,
) {
  return Effect.all({
    login: client.request({ type: "get_login_providers" }),
    models: client.request({ type: "get_available_models" }),
    state: client.request({ type: "get_state" }),
    roles: client.capabilities.has(NEOPI_CAPABILITIES.getRoles)
      ? client.request({ type: "get_roles" })
      : Effect.succeed(undefined),
  });
}

export const resolveNeoPiBinary = Effect.fn("resolveNeoPiBinary")(function* (
  settings: Pick<NeoPiSettings, "binaryPath">,
  environment: Record<string, string>,
  cwd: string,
) {
  const useDefaultSearch = !settings.binaryPath || settings.binaryPath === "npi";
  const commands = useDefaultSearch ? ["npi", "omp"] : [settings.binaryPath];
  for (const candidate of commands) {
    const probe = yield* spawnAndCollect(
      candidate,
      ChildProcess.make(candidate, ["--version"], { cwd, env: environment }),
    ).pipe(Effect.timeoutOption("4 seconds"), Effect.result);
    if (Result.isSuccess(probe) && Option.isSome(probe.success) && probe.success.value.code === 0) {
      return {
        binary: candidate,
        version: parseGenericCliVersion(probe.success.value.stdout + probe.success.value.stderr),
        error: null,
      };
    }
    if (
      useDefaultSearch &&
      candidate === "npi" &&
      Result.isFailure(probe) &&
      isCommandMissingCause(probe.failure)
    )
      continue;
    return {
      binary: candidate,
      version: null,
      error: Result.isSuccess(probe)
        ? Option.isNone(probe.success)
          ? "version probe timed out"
          : `version probe exited ${probe.success.value.code}`
        : String(probe.failure),
    };
  }
  return null;
});

export function authFromLoginProviders(
  data: unknown,
  activeProvider?: string,
): "authenticated" | "unknown" {
  const providers =
    typeof data === "object" &&
    data !== null &&
    "providers" in data &&
    Array.isArray(data.providers)
      ? data.providers
      : [];
  return providers.some(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "authenticated" in entry &&
      entry.authenticated === true &&
      (activeProvider === undefined || ("id" in entry && entry.id === activeProvider)),
  )
    ? "authenticated"
    : "unknown";
}

/** A configured executable never silently falls back to a different account or installation. */
export const checkNeoPiProviderStatus = Effect.fn("checkNeoPiProviderStatus")(function* (
  settings: NeoPiSettings,
  environment: Record<string, string>,
  cwd: string,
  spawn: SpawnFn,
  hub: NeoPiDiscoveryHub,
  sharedSessionCapabilities?: Set<string>,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  sharedSessionCapabilities?.clear();
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled)
    return fromProbe(settings, checkedAt, { installed: false, status: "warning" });
  const env = { ...environment, ...(settings.profile ? { OMP_PROFILE: settings.profile } : {}) };
  const resolved = yield* resolveNeoPiBinary(settings, env, cwd);
  if (!resolved || resolved.error)
    return fromProbe(settings, checkedAt, {
      installed: false,
      status: "error",
      message: resolved?.error
        ? `NeoPi/OMP binary '${resolved.binary}' could not be probed: ${resolved.error}.`
        : !settings.binaryPath || settings.binaryPath === "npi"
          ? "NeoPi/OMP CLI (`npi` or `omp`) is not installed or not on PATH."
          : `Configured NeoPi/OMP binary '${settings.binaryPath}' could not be executed.`,
    });
  const { binary: selected, version } = resolved;
  const metadata = yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* makeClient({
        spawn,
        command: selected,
        args: [
          "--mode",
          "rpc-ui",
          "--cwd",
          cwd,
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-rules",
          "--no-title",
        ],
        cwd,
        env,
      });
      const compatibility = neopiCompatibility(client.ready, client.capabilities.has("v2"));
      if (compatibility.status === "unsupported")
        return {
          login: null,
          models: null,
          roles: undefined,
          state: null,
          compatibility,
          readyCapabilities: [],
        };
      const metadata = yield* requestNeoPiProviderMetadata(client);
      return {
        ...metadata,
        compatibility,
        readyCapabilities: client.ready.capabilities ?? [],
      };
    }),
  ).pipe(Effect.timeoutOption("20 seconds"), Effect.result);
  if (Result.isFailure(metadata) || Option.isNone(metadata.success))
    return fromProbe(settings, checkedAt, {
      installed: true,
      version,
      status: "warning",
      message: "NeoPi/OMP RPC metadata probe failed; check the CLI and profile.",
    });
  const { login, models, roles, state, compatibility, readyCapabilities } = metadata.success.value;
  for (const capability of readyCapabilities) sharedSessionCapabilities?.add(capability);
  const current =
    typeof state === "object" && state !== null && "model" in state ? state.model : undefined;
  const currentProvider =
    typeof current === "object" &&
    current !== null &&
    "provider" in current &&
    typeof current.provider === "string"
      ? current.provider
      : "";
  const auth = authFromLoginProviders(login, currentProvider);
  const fastModeEnabled =
    typeof state === "object" &&
    state !== null &&
    "fastModeEnabled" in state &&
    state.fastModeEnabled === true;
  const available = modelsFromNeoPiRpc(models, current, fastModeEnabled, roles);
  const missingCurrent = available.some((model) => model.isCustom);
  const snapshot = fromProbe(settings, checkedAt, {
    installed: true,
    version,
    status: compatibility.status === "unsupported" ? "error" : missingCurrent ? "warning" : "ready",
    ...(compatibility.message || missingCurrent
      ? {
          message:
            compatibility.message ??
            "Current NeoPi/OMP model is not in the refreshed catalog; it remains selectable as a custom model.",
        }
      : {}),
    compatibilityAdvisory: compatibility,
    auth,
    showInteractionModeToggle: readyCapabilities.includes(NEOPI_CAPABILITIES.setMode),
    models: providerModelsFromSettings(
      available,
      settings.customModels ?? [],
      createModelCapabilities({ optionDescriptors: [] }),
    ),
  });
  const discovery = yield* hub.latest(cwd);
  return {
    ...snapshot,
    slashCommands: [
      COMPACT_SLASH_COMMAND,
      ...discovery.commands.filter((command) => command.name !== "compact"),
    ],
    skills: [...discovery.skills],
  };
});

/** Live session discovery takes precedence over the disposable full-loadout probe. */
export const neoPiSnapshotForCwd = (
  base: ServerProvider,
  cwd: string,
  hub: NeoPiDiscoveryHub,
  probe: NeoPiDiscoveryProbe,
) =>
  Effect.gen(function* () {
    const latest = yield* hub.latest(cwd);
    if (base.enabled && base.installed && base.status !== "error" && latest.source !== "live")
      yield* probe.probe(cwd);
    const found = yield* hub.latest(cwd);
    return {
      ...base,
      ...(found.source === "not-loaded" ? { message: "Commands not loaded yet" } : {}),
      slashCommands: [
        COMPACT_SLASH_COMMAND,
        ...found.commands.filter((command) => command.name !== "compact"),
      ],
      skills: [...found.skills],
    } satisfies ServerProvider;
  });
