// @effect-diagnostics nodeBuiltinImport:off -- launch builds this path before a Path service exists.
import { resolve } from "node:path";

/**
 * Tier-1 NeoPi session root shared by launch and usage history.
 *
 * Runtime writes `<baseDir>/neopi/sessions/<profile>/<projectId>`. `stateDir`
 * is `<baseDir>/userdata` or `<baseDir>/dev` (`deriveServerPaths`) and is not
 * the write root. The usage page used to scan `<stateDir>/neopi/sessions`;
 * that directory is the legacy root and is only scanned when it already exists.
 * Do not move files between the two.
 */
export interface NeoPiServerPaths {
  readonly baseDir: string;
  readonly stateDir: string;
}

export interface NeoPiSessionRoots {
  readonly canonical: string;
  readonly legacy: string;
}

/** Encode one path segment the same way launch has always encoded profile and project id. */
export function neopiSessionSegment(value: string): string {
  const encoded = encodeURIComponent(value.trim());
  return encoded === "" || encoded === "." || encoded === ".."
    ? "default"
    : encoded.replaceAll(".", "%2E");
}

/** `<baseDir>/neopi/sessions`. This is the directory launch must pass to `--session-dir`'s parent. */
export function neopiSessionRoot(input: { readonly baseDir: string }): string {
  return resolve(input.baseDir, "neopi", "sessions");
}

/**
 * Previous usage-scan root, `<stateDir>/neopi/sessions`. Scan it when it exists.
 * Never pass it to `--session-dir`.
 */
export function neopiLegacySessionRoot(input: { readonly stateDir: string }): string {
  return resolve(input.stateDir, "neopi", "sessions");
}

export function resolveNeoPiSessionRoots(input: NeoPiServerPaths): NeoPiSessionRoots {
  return {
    canonical: neopiSessionRoot(input),
    legacy: neopiLegacySessionRoot(input),
  };
}

/** The directory one T3 project writes for one NeoPi profile. Resume cursors may still name an older directory. */
export function neopiProjectSessionDir(input: {
  readonly baseDir: string;
  readonly profile?: string;
  readonly projectId: string;
}): string {
  return resolve(
    neopiSessionRoot(input),
    neopiSessionSegment(input.profile || "default"),
    neopiSessionSegment(input.projectId),
  );
}
