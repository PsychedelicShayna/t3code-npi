import type { NeoPiSettings, ServerProviderModel } from "@t3tools/contracts";
import { NEOPI_CURRENT_MODEL } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import type { SpawnFn } from "effect-neopi-rpc/client";
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
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { providerModelsFromSettings } from "../providerSnapshot.ts";
import type { NeoPiDiscoveryHub } from "../neopi/NeoPiDiscovery.ts";

const PRESENTATION = {
  displayName: "NeoPi/OMP",
  badgeLabel: "OMP RPC",
  showInteractionModeToggle: false,
  reportsContextWindow: true,
  supportsConversationRollback: false,
} as const;
const DEFAULT_MODEL: ServerProviderModel = {
  slug: NEOPI_CURRENT_MODEL,
  name: "Current model",
  isCustom: false,
  isDefault: true,
  capabilities: null,
};
const fallbackModels = (settings: NeoPiSettings) =>
  providerModelsFromSettings(
    [DEFAULT_MODEL],
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
  },
): ServerProviderDraft =>
  buildServerProvider({
    presentation: PRESENTATION,
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

export function modelsFromNeoPiRpc(data: unknown): ReadonlyArray<ServerProviderModel> {
  if (
    typeof data !== "object" ||
    data === null ||
    !("models" in data) ||
    !Array.isArray(data.models)
  )
    return [];
  return data.models.flatMap((model: unknown) => {
    if (
      typeof model !== "object" ||
      model === null ||
      !("provider" in model) ||
      !("id" in model) ||
      typeof model.provider !== "string" ||
      typeof model.id !== "string"
    )
      return [];
    const name = "name" in model && typeof model.name === "string" ? model.name : model.id;
    return [
      {
        slug: `${model.provider}/${model.id}`,
        name,
        shortName: model.id,
        subProvider: model.provider,
        isCustom: false,
        capabilities: null,
      },
    ];
  });
}

export const resolveNeoPiBinary = Effect.fn("resolveNeoPiBinary")(function* (
  settings: Pick<NeoPiSettings, "binaryPath">,
  environment: Record<string, string>,
  cwd: string,
) {
  const commands = settings.binaryPath ? [settings.binaryPath] : ["npi", "omp"];
  for (const candidate of commands) {
    const probe = yield* spawnAndCollect(
      candidate,
      ChildProcess.make(candidate, ["--version"], { cwd, env: environment }),
    ).pipe(Effect.timeoutOption("4 seconds"), Effect.result);
    if (Result.isSuccess(probe) && Option.isSome(probe.success) && probe.success.value.code === 0) {
      return {
        binary: candidate,
        version: parseGenericCliVersion(probe.success.value.stdout + probe.success.value.stderr),
      };
    }
  }
  return null;
});

export function authFromLoginProviders(data: unknown): "authenticated" | "unknown" {
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
      entry.authenticated === true,
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
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled)
    return fromProbe(settings, checkedAt, { installed: false, status: "warning" });
  const env = { ...environment, ...(settings.profile ? { OMP_PROFILE: settings.profile } : {}) };
  const resolved = yield* resolveNeoPiBinary(settings, env, cwd);
  if (!resolved)
    return fromProbe(settings, checkedAt, {
      installed: false,
      status: "error",
      message: settings.binaryPath
        ? `Configured NeoPi/OMP binary '${settings.binaryPath}' could not be executed.`
        : "NeoPi/OMP CLI (`npi` or `omp`) is not installed or not on PATH.",
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
      const [login, models] = yield* Effect.all([
        client.request({ type: "get_login_providers" }),
        client.request({ type: "get_available_models" }),
      ]);
      return { login, models };
    }),
  ).pipe(Effect.timeoutOption("20 seconds"), Effect.result);
  if (Result.isFailure(metadata) || Option.isNone(metadata.success))
    return fromProbe(settings, checkedAt, {
      installed: true,
      version,
      status: "warning",
      message: "NeoPi/OMP RPC metadata probe failed; check the CLI and profile.",
    });
  const { login, models } = metadata.success.value;
  const auth = authFromLoginProviders(login);
  const available = modelsFromNeoPiRpc(models);
  const discovery = yield* hub.latest(cwd);
  const snapshot = fromProbe(settings, checkedAt, {
    installed: true,
    version,
    status: "ready",
    auth,
    models: providerModelsFromSettings(
      available.length ? available : [DEFAULT_MODEL],
      settings.customModels ?? [],
      createModelCapabilities({ optionDescriptors: [] }),
    ),
  });
  return {
    ...snapshot,
    slashCommands: [
      COMPACT_SLASH_COMMAND,
      ...discovery.commands.filter((command) => command.name !== "compact"),
    ],
    skills: [...discovery.skills],
  };
});
