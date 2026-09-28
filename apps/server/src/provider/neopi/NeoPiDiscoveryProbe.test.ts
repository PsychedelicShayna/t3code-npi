import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeNeoPiDiscoveryHub } from "./NeoPiDiscovery.ts";
import { makeNeoPiDiscoveryProbe } from "./NeoPiDiscoveryProbe.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

it.live(
  "probes full loadout per cwd, keeps live results dominant and invalidates cached probes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeNeoPiDiscoveryHub();
        const launches: ReadonlyArray<string>[] = [];
        const probe = makeNeoPiDiscoveryProbe({
          binary: "npi",
          profile: "work",
          env: { OMP_PROFILE: "work" },
          hub,
          spawn: (command) =>
            Effect.gen(function* () {
              if (!ChildProcess.isStandardCommand(command))
                throw new Error("Expected a standard command");
              launches.push(command.args);
              const outbound = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
              const done = yield* Deferred.make<void>();
              yield* Queue.offer(
                outbound,
                new TextEncoder().encode(
                  '{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2]}\n',
                ),
              );
              const writer = Sink.forEach((bytes: Uint8Array) =>
                Effect.gen(function* () {
                  const frame = decode(new TextDecoder().decode(bytes));
                  if (typeof frame !== "object" || frame === null || !("type" in frame)) return;
                  const response = {
                    type: "response",
                    id: "id" in frame ? frame.id : undefined,
                    command: frame.type,
                    success: true,
                    data:
                      frame.type === "negotiate_protocol"
                        ? { protocolVersion: 2 }
                        : {
                            commands: [
                              { name: "build", source: "extension", input: { hint: "target" } },
                              { name: "skill:unslop", source: "skill", description: "Remove slop" },
                            ],
                          },
                  };
                  yield* Queue.offer(outbound, new TextEncoder().encode(`${encode(response)}\n`));
                }),
              );
              return ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(999),
                exitCode: Deferred.await(done).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                isRunning: Deferred.isDone(done).pipe(Effect.map((finished) => !finished)),
                kill: () =>
                  Effect.gen(function* () {
                    yield* Queue.end(outbound).pipe(Effect.ignore);
                    yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
                  }),
                stdin: writer,
                stdout: Stream.fromQueue(outbound),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
              });
            }),
        });
        const first = yield* probe.probe("/workspace/a");
        assert.deepEqual(first.commands, [
          { name: "build", input: { hint: "target" }, source: "extension" },
        ]);
        assert.deepEqual(
          first.skills.map((skill) => skill.name),
          ["unslop"],
        );
        assert.equal(launches.length, 1);
        assert.deepEqual(launches[0]?.slice(0, 2), ["--mode", "rpc-ui"]);
        assert.equal(launches[0]?.includes("--no-skills"), false);
        assert.equal(launches[0]?.includes("--no-extensions"), false);
        yield* probe.probe("/workspace/a");
        assert.equal(launches.length, 1);
        yield* probe.probe("/workspace/b");
        assert.equal(launches.length, 2);
        yield* hub.publish({
          cwd: "/workspace/a",
          source: "live",
          at: "2026-09-27T00:00:00Z",
          commands: [{ name: "from-live" }],
          skills: [],
        });
        yield* probe.invalidate;
        yield* probe.probe("/workspace/a");
        assert.equal(launches.length, 3);
        assert.deepEqual((yield* hub.latest("/workspace/a")).commands, [{ name: "from-live" }]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
