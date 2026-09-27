import { NeoPiSettings, ProviderDriverKind } from "@t3tools/contracts";
import { make as makeClient } from "effect-neopi-rpc/client";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeNeoPiTextGeneration } from "../../textGeneration/NeoPiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeNeoPiAdapter } from "../Layers/NeoPiAdapter.ts";
import {
  buildInitialNeoPiProviderSnapshot,
  checkNeoPiProviderStatus,
  resolveNeoPiBinary,
} from "../Layers/NeoPiProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeNeoPiDiscoveryHub } from "../neopi/NeoPiDiscovery.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("neopi");
const decodeSettings = Schema.decodeSync(NeoPiSettings);

export type NeoPiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | ServerConfig
  | ServerSettingsService;

export const NeoPiDriver: ProviderDriver<NeoPiSettings, NeoPiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "NeoPi/OMP", supportsMultipleInstances: true },
  configSchema: NeoPiSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const env = {
        ...Object.fromEntries(
          Object.entries(processEnv).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        ...(config.profile ? { OMP_PROFILE: config.profile } : {}),
      };
      const effectiveConfig = { ...config, enabled } satisfies NeoPiSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stamp = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const discovery = yield* makeNeoPiDiscoveryHub();
      const resolved = enabled
        ? yield* resolveNeoPiBinary(effectiveConfig, env, serverConfig.cwd).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          )
        : null;
      const binary = resolved?.binary ?? (config.binaryPath || "npi");
      const adapter = yield* makeNeoPiAdapter({
        settings: effectiveConfig,
        instanceId,
        binary,
        cwd: serverConfig.cwd,
        t3Home: serverConfig.baseDir,
        attachmentsDir: serverConfig.attachmentsDir,
        environment: env,
        spawn: spawner.spawn,
        discovery,
      });
      const textGeneration = makeNeoPiTextGeneration({
        binary,
        env,
        spawn: spawner.spawn,
        makeClient,
      });
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<NeoPiSettings>>({
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: DRIVER_KIND,
              packageName: null,
            }),
          ),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialNeoPiProviderSnapshot(settings.provider).pipe(Effect.map(stamp)),
        checkProvider: checkNeoPiProviderStatus(
          effectiveConfig,
          env,
          serverConfig.cwd,
          spawner.spawn,
          discovery,
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.map(stamp),
        ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build NeoPi/OMP snapshot: ${cause.message}`,
              cause,
            }),
        ),
      );
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
        snapshotForCwd: (cwd) =>
          Effect.all([snapshot.getSnapshot, discovery.latest(cwd)]).pipe(
            Effect.map(([base, found]) => ({
              ...base,
              slashCommands: [
                {
                  name: "compact",
                  description: "Summarize the conversation and reduce context usage",
                },
                ...found.commands.filter((command) => command.name !== "compact"),
              ],
              skills: [...found.skills],
            })),
          ),
      } satisfies ProviderInstance;
    }),
};
