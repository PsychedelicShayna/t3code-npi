// @effect-diagnostics nodeBuiltinImport:off -- CLI handoff runs before Effect loads.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

/** Run the bundled terminal agent without starting the desktop application. */
export function runNeoPiCli(): boolean {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Runs before the Effect runtime.
  if (process.platform !== "linux" || process.defaultApp) return false;
  const argumentIndex = process.argv.indexOf("--npi", 1);
  if (argumentIndex < 0) return false;

  const binary = NodePath.join(process.resourcesPath, "bin", "npi");
  const result = NodeChildProcess.spawnSync(binary, process.argv.slice(argumentIndex + 1), {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error)
    process.stderr.write(`Cannot execute bundled npi at ${binary}: ${result.error}\n`);
  process.exit(result.status ?? 1);
}
