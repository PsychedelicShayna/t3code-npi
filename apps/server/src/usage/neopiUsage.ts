// Node fs streams NeoPi session JSONL. The files are append-only and can be large;
// a line reader keeps tool-output transcripts off the heap.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeTimersPromises from "node:timers/promises";

import type { UsageRecord } from "./usageTranscripts.ts";

const CONFIG_DIR_NAME = ".omp";
const XDG_DIR_NAME = "omp";

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function errorCode(cause: unknown): string | undefined {
  return object(cause)?.code === "ENOENT" || typeof object(cause)?.code === "string"
    ? (object(cause)?.code as string)
    : undefined;
}

function reportedCost(usage: Record<string, unknown>): number | null {
  const cost = object(usage.cost);
  const total = cost?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

function usageRecord(input: {
  readonly filePath: string;
  readonly sessionId: string;
  readonly entryId: string;
  readonly provider: string;
  readonly model: string;
  readonly usage: Record<string, unknown>;
  readonly timestampMs: number;
}): UsageRecord {
  return {
    provider: "neopi",
    timestampMs: input.timestampMs,
    model: `${input.provider}/${input.model}`,
    sessionId: input.sessionId,
    totals: {
      uncachedInputTokens: tokens(input.usage.input),
      cachedInputTokens: tokens(input.usage.cacheRead),
      cacheCreationTokens: tokens(input.usage.cacheWrite),
      outputTokens: tokens(input.usage.output),
      reasoningTokens: tokens(input.usage.reasoningTokens),
    },
    reportedCostUsd: reportedCost(input.usage),
    fast: false,
    // File-qualified so the aggregator does not collapse unrelated 8-hex ids.
    // Copied branch entries are dropped before they become records; see
    // `ancestorEntryIds`.
    dedupeKey: `${input.filePath}:${input.entryId}`,
  };
}

/**
 * One assistant `message` with usage, or one `model_usage` entry.
 * Title-slot, session-header, user, and malformed lines yield nothing.
 */
function parseNeoPiUsageEntry(
  value: unknown,
  filePath: string,
  sessionId: string,
): { readonly entryId: string; readonly record: UsageRecord } | null {
  const entry = object(value);
  if (entry === null) return null;
  const entryId = text(entry.id);
  if (entryId.length === 0) return null;

  if (entry.type === "message") {
    const message = object(entry.message);
    if (message === null || message.role !== "assistant") return null;
    const usage = object(message.usage);
    const provider = text(message.provider);
    const model = text(message.model);
    const stamped = timestampMs(message.timestamp) ?? timestampMs(entry.timestamp);
    if (usage === null || provider.length === 0 || model.length === 0 || stamped === null) {
      return null;
    }
    return {
      entryId,
      record: usageRecord({
        filePath,
        sessionId,
        entryId,
        provider,
        model,
        usage,
        timestampMs: stamped,
      }),
    };
  }

  if (entry.type === "model_usage") {
    const usage = object(entry.usage);
    const provider = text(entry.provider);
    const model = text(entry.model);
    const stamped = timestampMs(entry.timestamp);
    if (usage === null || provider.length === 0 || model.length === 0 || stamped === null) {
      return null;
    }
    return {
      entryId,
      record: usageRecord({
        filePath,
        sessionId,
        entryId,
        provider,
        model,
        usage,
        timestampMs: stamped,
      }),
    };
  }

  return null;
}

interface ParsedSession {
  readonly path: string;
  readonly root: string;
  readonly headerId: string | null;
  readonly parentSession: string | null;
  readonly rows: ReadonlyArray<{ readonly entryId: string; readonly record: UsageRecord }>;
  readonly readError: boolean;
}

async function parseSessionFile(filePath: string, root: string): Promise<ParsedSession> {
  const rows: Array<{ readonly entryId: string; readonly record: UsageRecord }> = [];
  let headerId: string | null = null;
  let parentSession: string | null = null;
  let headerSeen = false;
  let count = 0;
  let readError = false;
  const stream = NodeFS.createReadStream(filePath, { encoding: "utf8" });
  const lines = NodeReadline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (++count % 256 === 0) await NodeTimersPromises.setImmediate();
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const entry = object(value);
      if (entry === null) continue;
      // Fixed 256-byte title slot, and the session header. Neither is usage.
      if (entry.type === "title") continue;
      if (entry.type === "session") {
        if (!headerSeen) {
          headerSeen = true;
          const id = text(entry.id);
          headerId = id.length > 0 ? id : null;
          const parent = text(entry.parentSession);
          parentSession = parent.length > 0 ? parent : null;
        }
        continue;
      }
      if (!headerSeen || headerId === null) continue;
      const parsed = parseNeoPiUsageEntry(value, filePath, headerId);
      if (parsed !== null) rows.push(parsed);
    }
  } catch {
    readError = true;
  } finally {
    lines.close();
    stream.destroy();
  }
  return { path: filePath, root, headerId, parentSession, rows, readError };
}

async function walkSessions(
  dir: string,
  root: string,
  sinceMs: number,
  out: ParsedSession[],
): Promise<boolean> {
  let entries;
  try {
    entries = await NodeFSP.readdir(dir, { withFileTypes: true });
  } catch (cause) {
    return errorCode(cause) !== "ENOENT";
  }
  let error = false;
  for (const entry of entries) {
    // Do not follow symlinks, including cycles into the same tree.
    const child = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await walkSessions(child, root, sinceMs, out)) error = true;
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const stats = await NodeFSP.stat(child);
      if (stats.mtimeMs < sinceMs) continue;
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") error = true;
      continue;
    }
    const parsed = await parseSessionFile(child, root);
    out.push(parsed);
    if (parsed.readError) error = true;
  }
  return error;
}

function resolveParent(
  file: ParsedSession,
  byPath: ReadonlyMap<string, ParsedSession>,
  byId: ReadonlyMap<string, ParsedSession>,
): ParsedSession | undefined {
  const parentSession = file.parentSession;
  if (parentSession === null) return undefined;
  const bySessionId = byId.get(parentSession);
  if (bySessionId !== undefined && bySessionId.path !== file.path) return bySessionId;
  const resolved = NodePath.resolve(NodePath.dirname(file.path), parentSession);
  const byFile = byPath.get(resolved) ?? byPath.get(NodePath.resolve(parentSession));
  return byFile !== undefined && byFile.path !== file.path ? byFile : undefined;
}

/**
 * Entry ids already counted on an ancestor in this scan.
 *
 * `branch` / fork copy the kept path into a new file and set `parentSession`
 * to the source file or its session id. Those copies keep their entry ids.
 * The aggregator's dedupe key is file-qualified, so lineage dedupe has to
 * happen here or the Usage page would bill the copied turns twice.
 */
function ancestorEntryIds(
  file: ParsedSession,
  byPath: ReadonlyMap<string, ParsedSession>,
  byId: ReadonlyMap<string, ParsedSession>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  const seen = new Set<string>();
  let current: ParsedSession | undefined = file;
  while (current !== undefined) {
    const parent = resolveParent(current, byPath, byId);
    if (parent === undefined || seen.has(parent.path)) break;
    seen.add(parent.path);
    for (const row of parent.rows) ids.add(row.entryId);
    current = parent;
  }
  return ids;
}

export interface NeoPiUsageRootResult {
  readonly dir: string;
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
}

export interface NeoPiUsageReadResult {
  readonly roots: readonly NeoPiUsageRootResult[];
}

interface CanonicalRoot {
  readonly reported: string;
  readonly canonical: string;
}

async function canonicalizeRoots(roots: readonly string[]): Promise<readonly CanonicalRoot[]> {
  const seen = new Set<string>();
  const canonical: CanonicalRoot[] = [];
  for (const root of roots) {
    const resolved = NodePath.resolve(root);
    let identity = resolved;
    try {
      identity = await NodeFSP.realpath(resolved);
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT" && errorCode(cause) !== "ENOTDIR") {
        // Still report the path; the walk will record the error.
      }
    }
    if (seen.has(identity)) continue;
    seen.add(identity);
    canonical.push({ reported: resolved, canonical: identity });
  }
  return canonical;
}

/** Reads every `*.jsonl` under `roots` and drops branch copies of ancestor entries. */
export async function readNeoPiUsage(
  roots: readonly string[],
  sinceMs: number,
): Promise<NeoPiUsageReadResult> {
  const canonical = await canonicalizeRoots(roots);
  const parsed: ParsedSession[] = [];
  const status = new Map<string, { missing: boolean; error: boolean }>();

  for (const root of canonical) {
    const rootStatus = { missing: false, error: false };
    status.set(root.reported, rootStatus);
    let stats;
    try {
      stats = await NodeFSP.stat(root.canonical);
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") rootStatus.missing = true;
      else rootStatus.error = true;
      continue;
    }
    if (!stats.isDirectory()) {
      rootStatus.error = true;
      continue;
    }
    if (await walkSessions(root.canonical, root.reported, sinceMs, parsed)) {
      rootStatus.error = true;
    }
  }

  const byPath = new Map<string, ParsedSession>();
  const byId = new Map<string, ParsedSession>();
  for (const file of parsed) {
    byPath.set(file.path, file);
    byPath.set(NodePath.resolve(file.path), file);
    if (file.headerId !== null && !byId.has(file.headerId)) byId.set(file.headerId, file);
  }

  const kept = new Map<string, UsageRecord[]>();
  for (const file of parsed) {
    const copied = ancestorEntryIds(file, byPath, byId);
    const records: UsageRecord[] = [];
    for (const row of file.rows) {
      if (copied.has(row.entryId)) continue;
      if (row.record.timestampMs < sinceMs) continue;
      records.push(row.record);
    }
    kept.set(file.path, records);
  }

  return {
    roots: canonical.map((root) => {
      const rootStatus = status.get(root.reported) ?? { missing: false, error: false };
      return {
        dir: root.reported,
        missing: rootStatus.missing,
        error: rootStatus.error,
        files: parsed
          .filter((file) => file.root === root.reported)
          .map((file) => ({ path: file.path, records: kept.get(file.path) ?? [] })),
      };
    }),
  };
}

async function existingProfileSessionDirs(profilesRoot: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await NodeFSP.readdir(profilesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessions = NodePath.join(profilesRoot, entry.name, "agent", "sessions");
    try {
      if ((await NodeFSP.stat(sessions)).isDirectory()) dirs.push(sessions);
    } catch {
      // A profile with no session directory is not a usage source.
    }
  }
  return dirs;
}

export interface NeoPiSessionRootInput {
  readonly home: string;
  readonly stateDir: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Directories the usage scan should open.
 *
 * Always includes `~/.omp/agent/sessions` (or `PI_CONFIG_DIR`) and the Tier 1
 * T3 directory `<stateDir>/neopi/sessions/<profile>/<projectId>`. Named-profile
 * and XDG session dirs are included only when they already exist, so an unused
 * profile does not show up as a missing source.
 */
export async function discoverNeoPiSessionRoots(
  input: NeoPiSessionRootInput,
): Promise<readonly string[]> {
  const configDirName = input.env.PI_CONFIG_DIR?.trim() || CONFIG_DIR_NAME;
  const homeConfig = NodePath.resolve(input.home, configDirName);
  const roots = [
    NodePath.join(input.home, CONFIG_DIR_NAME, "agent", "sessions"),
    NodePath.join(homeConfig, "agent", "sessions"),
    NodePath.join(input.stateDir, "neopi", "sessions"),
  ];
  const agentDir = input.env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) roots.push(NodePath.join(agentDir, "sessions"));

  const xdgData = input.env.XDG_DATA_HOME?.trim();
  if (xdgData && NodePath.isAbsolute(xdgData)) {
    const xdgRoot = NodePath.join(xdgData, XDG_DIR_NAME);
    try {
      if ((await NodeFSP.stat(xdgRoot)).isDirectory()) {
        roots.push(NodePath.join(xdgRoot, "sessions"));
        roots.push(...(await existingProfileSessionDirs(NodePath.join(xdgRoot, "profiles"))));
      }
    } catch {
      // XDG is opt-in; a missing root means NeoPi is still on ~/.omp.
    }
  }
  roots.push(...(await existingProfileSessionDirs(NodePath.join(homeConfig, "profiles"))));

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const resolved = NodePath.resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    unique.push(resolved);
  }
  return unique;
}
