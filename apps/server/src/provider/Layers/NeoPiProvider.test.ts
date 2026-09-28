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

const previousCatalog = {
  models: [
    {
      slug: "openai/gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "@smol",
      name: "Fast",
      isCustom: false,
      capabilities: null,
    },
  ],
  roles: {
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
  },
};

const writeSlowPeer = (dir: string): string => {
  const peer = Path.join(dir, "peer.mjs");
  const binary = Path.join(dir, "npi");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  Fs.writeFileSync(
    peer,
    [
      "import readline from 'node:readline';",
      "if (process.env.NEOPI_MOCK_MODE !== 'hang-handshake') {",
      "  process.stdout.write(JSON.stringify({",
      "    type: 'ready',",
      "    protocolVersion: 1,",
      "    supportedProtocolVersions: [1, 2],",
      "    maxFrameBytes: 1048576,",
      "    maxReassembledFrameBytes: 8388608,",
      "    capabilities: ['set_mode', 'get_roles', 'rpc-ui'],",
      "  }) + '\\n');",
      "}",
      "const lines = readline.createInterface({ input: process.stdin });",
      "lines.on('line', (line) => {",
      "  if (!line.trim()) return;",
      "  let message;",
      "  try { message = JSON.parse(line); } catch { return; }",
      "  if (!message || message.type !== 'negotiate_protocol') return;",
      "  process.stdout.write(JSON.stringify({",
      "    id: message.id,",
      "    type: 'response',",
      "    command: 'negotiate_protocol',",
      "    success: true,",
      "    data: { protocolVersion: 2 },",
      "  }) + '\\n');",
      "});",
      "lines.on('close', () => process.exit(0));",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1 << 30);",
      "",
    ].join("\n"),
  );
  Fs.writeFileSync(
    binary,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "npi v9.9.9"; exit 0; fi\nexec ${quote(process.execPath)} ${quote(peer)}\n`,
    { mode: 0o755 },
  );
  return binary;
};

it.live("publishes ready capabilities when metadata times out and keeps the previous catalog", () =>
  Effect.gen(function* () {
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-neopi-slow-meta-"));
    try {
      const binary = writeSlowPeer(dir);
      const capabilities = new Set<string>();
      const discovery = yield* makeNeoPiDiscoveryHub();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const result = yield* checkNeoPiProviderStatus(
        { ...settings, binaryPath: binary },
        { NEOPI_MOCK_MODE: "hang-metadata" },
        dir,
        spawner.spawn,
        discovery,
        capabilities,
        {
          previous: previousCatalog,
          handshakeTimeout: "5 seconds",
          metadataTimeout: "250 millis",
        },
      );
      assert.equal(result.installed, true);
      assert.equal(result.status, "warning");
      assert.match(result.message ?? "", /metadata probe timed out/);
      assert.equal(/handshake timed out/.test(result.message ?? ""), false);
      assert.equal(result.showInteractionModeToggle, true);
      assert.equal(result.compatibilityAdvisory?.status, "supported");
      assert.deepEqual(
        result.models.map((model) => model.slug),
        ["openai/gpt-5.6-luna", "@smol"],
      );
      assert.equal(capabilities.has(NEOPI_CAPABILITIES.setMode), true);
      assert.equal(capabilities.has(NEOPI_CAPABILITIES.getRoles), true);
    } finally {
      Fs.rmSync(dir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "names a handshake timeout and does not publish capabilities from a peer that never readied",
  () =>
    Effect.gen(function* () {
      const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-neopi-slow-handshake-"));
      try {
        const binary = writeSlowPeer(dir);
        const capabilities = new Set<string>();
        const discovery = yield* makeNeoPiDiscoveryHub();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const result = yield* checkNeoPiProviderStatus(
          { ...settings, binaryPath: binary },
          { NEOPI_MOCK_MODE: "hang-handshake" },
          dir,
          spawner.spawn,
          discovery,
          capabilities,
          {
            previous: previousCatalog,
            handshakeTimeout: "200 millis",
            metadataTimeout: "200 millis",
          },
        );
        assert.equal(result.status, "warning");
        assert.match(result.message ?? "", /handshake timed out/);
        assert.equal(/metadata probe timed out/.test(result.message ?? ""), false);
        assert.equal(result.showInteractionModeToggle, false);
        assert.equal(capabilities.size, 0);
      } finally {
        Fs.rmSync(dir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
