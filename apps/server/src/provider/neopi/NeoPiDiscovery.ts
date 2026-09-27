import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export interface NeoPiDiscoverySnapshot {
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly source: "live" | "full-probe" | "not-loaded";
  readonly cwd: string;
  readonly at: string;
}

export interface NeoPiDiscoveryHub {
  readonly publish: (snapshot: NeoPiDiscoverySnapshot) => Effect.Effect<void>;
  readonly latest: (cwd: string) => Effect.Effect<NeoPiDiscoverySnapshot>;
  readonly changes: Stream.Stream<NeoPiDiscoverySnapshot>;
}

const priority = { "not-loaded": 0, "full-probe": 1, live: 2 } as const;

export const makeNeoPiDiscoveryHub = Effect.fn("NeoPiDiscoveryHub.make")(function* () {
  const byCwd = new Map<string, NeoPiDiscoverySnapshot>();
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<NeoPiDiscoverySnapshot>(),
    PubSub.shutdown,
  );
  return {
    publish: (snapshot) =>
      Effect.gen(function* () {
        const previous = byCwd.get(snapshot.cwd);
        if (previous && priority[previous.source] > priority[snapshot.source]) return;
        byCwd.set(snapshot.cwd, snapshot);
        yield* PubSub.publish(changes, snapshot);
      }),
    latest: (cwd) =>
      Effect.sync(
        () => byCwd.get(cwd) ?? { cwd, commands: [], skills: [], source: "not-loaded", at: "" },
      ),
    changes: Stream.fromPubSub(changes),
  } satisfies NeoPiDiscoveryHub;
});
