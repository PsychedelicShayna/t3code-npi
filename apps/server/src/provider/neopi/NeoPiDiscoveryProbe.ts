import { make as makeClient, type SpawnFn } from "effect-neopi-rpc/client";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type { NeoPiDiscoveryHub, NeoPiDiscoverySnapshot } from "./NeoPiDiscovery.ts";
import { toNeoPiCommandCatalog, type NeoPiAvailableCommand } from "./NeoPiCommandCatalog.ts";

const CACHE_MS = 10 * 60_000;

export interface NeoPiDiscoveryProbe {
  readonly probe: (
    cwd: string,
  ) => Effect.Effect<NeoPiDiscoverySnapshot, never, FileSystem.FileSystem>;
  readonly invalidate: Effect.Effect<void>;
}

/** Full user loadout, isolated from live T3 sessions and cleaned up after each probe. */
export function makeNeoPiDiscoveryProbe(input: {
  readonly binary: string;
  readonly profile: string;
  readonly env: Record<string, string>;
  readonly spawn: SpawnFn;
  readonly hub: NeoPiDiscoveryHub;
  readonly deadlineMs?: number;
}): NeoPiDiscoveryProbe {
  const cached = new Map<string, { at: number; snapshot: NeoPiDiscoverySnapshot }>();
  const probe = (
    cwd: string,
  ): Effect.Effect<NeoPiDiscoverySnapshot, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const key = `${input.binary}\0${input.profile}\0${cwd}`;
      const previous = cached.get(key);
      if (previous && (yield* Clock.currentTimeMillis) - previous.at < CACHE_MS)
        return previous.snapshot;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const sessionDir = yield* fs.makeTempDirectory({ prefix: "t3-neopi-discovery-" });
          yield* Effect.addFinalizer(() =>
            fs.remove(sessionDir, { recursive: true, force: true }).pipe(Effect.ignore),
          );
          const client = yield* makeClient({
            spawn: input.spawn,
            command: input.binary,
            args: [
              "--mode",
              "rpc",
              "--cwd",
              cwd,
              "--no-session",
              "--session-dir",
              sessionDir,
              "--no-title",
            ],
            cwd,
            env: input.env,
            requestTimeoutMs: input.deadlineMs ?? 30_000,
          });
          yield* Effect.addFinalizer(() => client.close(150));
          const response = yield* client.request({ type: "get_available_commands" });
          const commands =
            typeof response === "object" &&
            response !== null &&
            "commands" in response &&
            Array.isArray(response.commands)
              ? (response.commands as NeoPiAvailableCommand[])
              : [];
          const catalog = toNeoPiCommandCatalog(commands, client.capabilities);
          const snapshot: NeoPiDiscoverySnapshot = {
            cwd,
            source: "full-probe",
            at: DateTime.formatIso(yield* DateTime.now),
            commands: catalog.slashCommands,
            skills: catalog.skills,
          };
          yield* input.hub.publish(snapshot);
          cached.set(key, { at: yield* Clock.currentTimeMillis, snapshot });
          return snapshot;
        }),
      ).pipe(
        Effect.timeoutOption(`${input.deadlineMs ?? 30_000} millis`),
        Effect.orElseSucceed(() => Option.none<NeoPiDiscoverySnapshot>()),
        Effect.flatMap((result) =>
          Option.isSome(result) ? Effect.succeed(result.value) : input.hub.latest(cwd),
        ),
      );
    });
  return {
    probe,
    invalidate: Effect.sync(() => {
      cached.clear();
    }),
  };
}
