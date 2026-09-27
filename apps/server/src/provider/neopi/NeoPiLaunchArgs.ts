// @effect-diagnostics nodeBuiltinImport:off -- launch args are constructed before any runtime Path service exists.
import { resolve, sep } from "node:path";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import type { RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { neopiProjectSessionDir } from "./NeoPiPaths.ts";
import { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";
import type { NeoPiLaunchPlan, NeoPiResumeCursor } from "./NeoPiRuntimeTypes.ts";

export interface NeoPiLaunchInput {
  readonly binary: string;
  readonly cwd: string;
  readonly t3Home: string;
  readonly env?: Record<string, string>;
  readonly projectId: string;
  readonly profile?: string;
  readonly launchArgs?: string;
  readonly runtimeMode: RuntimeMode;
  readonly cursor?: NeoPiResumeCursor;
}

const approvalModes: Record<RuntimeMode, string> = {
  "approval-required": "always-ask",
  "auto-accept-edits": "write",
  auto: "yolo",
  "full-access": "yolo",
};

const protectedFlags = new Set([
  "--resume",
  "-r",
  "-c",
  "--continue",
  "--fork",
  "--mode",
  "--cwd",
  "--profile",
  "-p",
  "--approval-mode",
  "--yolo",
  "--auto-approve",
  "--no-session",
]);

export const buildNeoPiLaunchPlan = (
  input: NeoPiLaunchInput,
): Effect.Effect<NeoPiLaunchPlan, NeoPiRuntimeError> =>
  Effect.gen(function* () {
    const extra = tokenizeCliArgs(input.launchArgs);
    for (const arg of extra) {
      if (arg === "--") break;
      const flag = arg.split("=", 1)[0] ?? arg;
      if (flag.startsWith("--session") || protectedFlags.has(flag)) {
        return yield* new NeoPiRuntimeError({
          code: "settings",
          flag,
          message: `NeoPi/OMP launch arguments may not override ${flag}`,
        });
      }
    }
    // Flag advertisement alone is not a cooperating lifetime lease.
    const sessionDir =
      input.cursor?.sessionDir ??
      neopiProjectSessionDir({
        baseDir: input.t3Home,
        ...(input.profile !== undefined ? { profile: input.profile } : {}),
        projectId: input.projectId,
      });
    const args = [
      "--mode",
      "rpc-ui",
      "--cwd",
      input.cwd,
      "--no-title",
      "--session-dir",
      sessionDir,
    ];
    if (input.cursor) {
      if (
        !input.cursor.sessionFile ||
        !input.cursor.sessionId ||
        !resolve(input.cursor.sessionFile).startsWith(resolve(sessionDir) + sep)
      ) {
        return yield* new NeoPiRuntimeError({
          code: "settings",
          message: "NeoPi/OMP resume cursor is outside its session directory",
        });
      }
      args.push("--session", input.cursor.sessionFile);
    }
    args.push("--approval-mode", approvalModes[input.runtimeMode], ...extra);
    return {
      command: input.binary,
      args,
      cwd: input.cwd,
      sessionDir,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        ...input.env,
        ...(input.profile?.trim() ? { OMP_PROFILE: input.profile.trim() } : {}),
      },
      identity: input.cursor
        ? { kind: "resume" as const, cursor: input.cursor }
        : { kind: "fresh" as const },
    };
  });
