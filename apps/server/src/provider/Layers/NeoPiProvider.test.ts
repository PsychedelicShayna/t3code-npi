// @effect-diagnostics nodeBuiltinImport:off
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { NeoPiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeNeoPiDiscoveryHub } from "../neopi/NeoPiDiscovery.ts";
import { NEOPI_CAPABILITIES } from "../neopi/NeoPiCompatibility.ts";
import {
  authFromLoginProviders,
  buildInitialNeoPiProviderSnapshot,
  checkNeoPiProviderStatus,
  modelsFromNeoPiRpc,
  requestNeoPiProviderMetadata,
  resolveNeoPiBinary,
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
        authFromLoginProviders({ providers: [{ id: "openai", authenticated: true }] }, "local"),
        "unknown",
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
            quotaProvider: "openai-codex",
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                { id: "fastMode", type: "boolean", label: "Fast mode", currentValue: false },
              ],
            },
          },
        ],
      );
    }),
);

it.effect("does not ask a mock peer for roles without the get_roles capability", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const metadata = yield* requestNeoPiProviderMetadata({
      capabilities: new Set(),
      request: <C extends { type: string }>(command: C): Effect.Effect<unknown> => {
        requests.push(command.type);
        return Effect.succeed({});
      },
    });
    assert.deepEqual(requests, ["get_login_providers", "get_available_models", "get_state"]);
    assert.equal(metadata.roles, undefined);
  }),
);

it.effect("asks a capable mock peer for roles and exposes them in the picker", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const metadata = yield* requestNeoPiProviderMetadata({
      capabilities: new Set([NEOPI_CAPABILITIES.getRoles]),
      request: <C extends { type: string }>(command: C): Effect.Effect<unknown> => {
        requests.push(command.type);
        return Effect.succeed(
          command.type === "get_roles"
            ? {
                roles: [
                  {
                    id: "smol",
                    alias: "@smol",
                    name: "Fast",
                    source: "builtin",
                    patterns: ["openai/gpt-5.6-luna:low"],
                    hidden: false,
                  },
                ],
              }
            : {},
        );
      },
    });
    assert.deepEqual(requests, [
      "get_login_providers",
      "get_available_models",
      "get_state",
      "get_roles",
    ]);
    assert.equal(
      modelsFromNeoPiRpc(
        { models: [{ provider: "openai", id: "gpt-5.6-luna" }] },
        undefined,
        false,
        metadata.roles,
      )[0]?.slug,
      "@smol",
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
        assert.equal(initial.supportsConversationRollback, true);
        assert.deepEqual(
          initial.slashCommands.map((command) => command.name),
          ["compact"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
it.live("falls back only when the default npi executable is missing", () =>
  Effect.gen(function* () {
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-neopi-bin-"));
    try {
      const omp = Path.join(dir, "omp");
      Fs.writeFileSync(omp, "#!/bin/sh\necho 'omp v1.2.3'\n", { mode: 0o755 });
      const env = { PATH: dir };
      const fallback = yield* resolveNeoPiBinary({ binaryPath: "npi" }, env, dir);
      assert.equal(fallback?.binary, "omp");
      assert.equal(fallback?.version, "1.2.3");
      const npi = Path.join(dir, "npi");
      Fs.writeFileSync(npi, "#!/bin/sh\nexit 17\n", { mode: 0o755 });
      const failure = yield* resolveNeoPiBinary({ binaryPath: "npi" }, env, dir);
      assert.equal(failure?.binary, "npi");
      assert.match(failure?.error ?? "", /exited 17/);
      const explicit = yield* resolveNeoPiBinary(
        { binaryPath: Path.join(dir, "absent") },
        env,
        dir,
      );
      assert.equal(explicit?.binary, Path.join(dir, "absent"));
      assert.notEqual(explicit?.error, null);
    } finally {
      Fs.rmSync(dir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
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
