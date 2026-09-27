import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { NeoPiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeNeoPiDiscoveryHub } from "../neopi/NeoPiDiscovery.ts";
import {
  authFromLoginProviders,
  buildInitialNeoPiProviderSnapshot,
  checkNeoPiProviderStatus,
  modelsFromNeoPiRpc,
} from "./NeoPiProvider.ts";

const settings: NeoPiSettings = {
  enabled: true,
  binaryPath: "/no/such/npi-binary",
  profile: "",
  launchArgs: "",
  customModels: [],
};

it.effect(
  "only reports OAuth authentication that RPC explicitly confirms; API keys and local models stay unknown",
  () =>
    Effect.sync(() => {
      assert.equal(
        authFromLoginProviders({ providers: [{ id: "openai", authenticated: false }] }),
        "unknown",
      );
      assert.equal(authFromLoginProviders({ providers: [] }), "unknown");
      assert.equal(
        authFromLoginProviders({ providers: [{ id: "openai", authenticated: true }] }),
        "authenticated",
      );
      assert.equal(
        authFromLoginProviders({ providers: [{ id: "local", available: true }] }),
        "unknown",
      );
      assert.deepEqual(
        modelsFromNeoPiRpc({
          models: [{ provider: "openai-codex", id: "gpt-6-luna", name: "Luna" }],
        }),
        [
          {
            slug: "openai-codex/gpt-6-luna",
            name: "Luna",
            shortName: "gpt-6-luna",
            subProvider: "openai-codex",
            isCustom: false,
            capabilities: null,
          },
        ],
      );
    }),
);

it.live(
  "a configured executable that cannot run remains unavailable without falling back to npi",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const discovery = yield* makeNeoPiDiscoveryHub();
        const result = yield* checkNeoPiProviderStatus(
          settings,
          {},
          "/tmp",
          spawner.spawn,
          discovery,
        );
        assert.equal(result.installed, false);
        assert.equal(result.status, "error");
        assert.match(result.message ?? "", /\/no\/such\/npi-binary/);
        const initial = yield* buildInitialNeoPiProviderSnapshot({ ...settings, enabled: false });
        assert.equal(initial.status, "disabled");
        assert.deepEqual(
          initial.slashCommands.map((command) => command.name),
          ["compact"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("live commands take precedence over an older full-loadout probe", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hub = yield* makeNeoPiDiscoveryHub();
      yield* hub.publish({
        source: "full-probe",
        cwd: "/tmp",
        at: "1",
        commands: [{ name: "compact" }],
        skills: [],
      });
      yield* hub.publish({
        source: "live",
        cwd: "/tmp",
        at: "2",
        commands: [{ name: "compact" }, { name: "review" }],
        skills: [],
      });
      yield* hub.publish({
        source: "full-probe",
        cwd: "/tmp",
        at: "3",
        commands: [{ name: "stale" }],
        skills: [],
      });
      const latest = yield* hub.latest("/tmp");
      assert.deepEqual(
        latest.commands.map((command) => command.name),
        ["compact", "review"],
      );
      assert.equal(latest.source, "live");
    }),
  ),
);
