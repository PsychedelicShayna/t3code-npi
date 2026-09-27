// @effect-diagnostics nodeBuiltinImport:off
import { strict as assert } from "node:assert";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { buildNeoPiLaunchPlan } from "./NeoPiLaunchArgs.ts";

const input = {
  binary: "npi",
  cwd: "/tmp/project",
  t3Home: "/tmp/t3home",
  projectId: "project-1",
  profile: "work",
  runtimeMode: "approval-required" as const,
};

describe("NeoPi launch plan", () => {
  it.effect("isolates fresh sessions and resumes the exact file", () =>
    Effect.gen(function* () {
      const fresh = yield* buildNeoPiLaunchPlan(input);
      assert.deepEqual(fresh.args, [
        "--mode",
        "rpc-ui",
        "--cwd",
        "/tmp/project",
        "--no-title",
        "--session-dir",
        "/tmp/t3home/neopi/sessions/work/project-1",
        "--approval-mode",
        "always-ask",
      ]);
      assert.equal(fresh.env.OMP_PROFILE, "work");
      const resume = yield* buildNeoPiLaunchPlan({
        ...input,
        cursor: {
          v: 1,
          sessionDir: fresh.sessionDir,
          sessionFile: `${fresh.sessionDir}/file.jsonl`,
          sessionId: "s",
          turnBoundaries: [],
        },
      });
      assert.deepEqual(resume.args.slice(-2), ["--approval-mode", "always-ask"]);
      assert.equal(
        resume.args[resume.args.indexOf("--session") + 1],
        `${fresh.sessionDir}/file.jsonl`,
      );
    }),
  );
  it.effect(
    "maps both unrestricted modes to yolo and never lets extra args override identity",
    () =>
      Effect.gen(function* () {
        for (const runtimeMode of ["auto", "full-access"] as const) {
          const plan = yield* buildNeoPiLaunchPlan({ ...input, runtimeMode });
          assert.equal(plan.args[plan.args.indexOf("--approval-mode") + 1], "yolo");
        }
        for (const flag of [
          "--session=evil",
          "--session-dir",
          "--resume",
          "-r",
          "-c",
          "--continue",
          "--fork",
          "--mode=rpc",
          "--cwd",
          "--approval-mode",
          "--yolo",
          "--auto-approve",
          "--no-session",
        ]) {
          const result = yield* buildNeoPiLaunchPlan({
            ...input,
            launchArgs: `${flag} value`,
          }).pipe(Effect.flip);
          assert.equal(result.code, "settings");
          assert.ok(result.message.includes(result.flag!));
        }
      }),
  );
  it.effect("enables shared fresh files only with both native safety capabilities", () =>
    Effect.gen(function* () {
      const caps = new Set(["session_lease", "new_session_flag"]);
      const shared = yield* buildNeoPiLaunchPlan({
        ...input,
        knownCapabilities: caps,
        profile: "",
      });
      assert.equal(shared.identity.kind, "fresh");
      assert.equal(shared.sessionDir, "");
      assert.equal(shared.env.OMP_PROFILE, process.env.OMP_PROFILE);
      assert.ok(shared.args.includes("--new-session"));
      assert.ok(!shared.args.includes("--session-dir"));
      for (const single of ["session_lease", "new_session_flag"]) {
        const isolated = yield* buildNeoPiLaunchPlan({
          ...input,
          knownCapabilities: new Set([single]),
        });
        assert.ok(isolated.args.includes("--session-dir"));
        assert.ok(!isolated.args.includes("--new-session"));
      }
    }),
  );
  it.effect(
    "preserves the process environment, applies instance overrides, then the selected profile",
    () =>
      Effect.gen(function* () {
        const planned = yield* buildNeoPiLaunchPlan({
          ...input,
          env: {
            HOME: "/tmp/isolated-home",
            OMP_PROFILE: "environment-profile",
            CUSTOM_TOKEN: "instance",
          },
        });
        assert.equal(planned.env.HOME, "/tmp/isolated-home");
        assert.equal(planned.env.CUSTOM_TOKEN, "instance");
        assert.equal(planned.env.OMP_PROFILE, "work");
        assert.equal(planned.env.PATH, process.env.PATH);
        const noProfile = yield* buildNeoPiLaunchPlan({
          ...input,
          profile: "",
          env: { OMP_PROFILE: "environment-profile" },
        });
        assert.equal(noProfile.env.OMP_PROFILE, "environment-profile");
      }),
  );
});
