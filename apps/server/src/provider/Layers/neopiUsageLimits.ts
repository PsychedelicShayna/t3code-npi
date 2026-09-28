import { createHash } from "node:crypto";
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
  resolveUsageLimitsAfterProbe,
} from "../providerUsageLimits.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";

/** Managed-snapshot refresh is minutes; this only collapses a burst of probes. */
const PROBE_CACHE_TTL_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT = "20 seconds";

const UsageAmountSchema = Schema.Struct({
  used: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
  usedFraction: Schema.optional(Schema.Number),
  remainingFraction: Schema.optional(Schema.Number),
  unit: Schema.optional(Schema.String),
});

const UsageWindowSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(Schema.Number),
});

const UsageLimitSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  scope: Schema.optional(Schema.Unknown),
  window: Schema.optional(UsageWindowSchema),
  amount: UsageAmountSchema,
  status: Schema.optional(Schema.Unknown),
  notes: Schema.optional(Schema.Array(Schema.String)),
});

const ResetCreditSchema = Schema.Struct({
  id: Schema.String,
  expiresAt: Schema.optional(Schema.String),
});

const UsageReportSchema = Schema.Struct({
  provider: Schema.String,
  fetchedAt: Schema.optional(Schema.Number),
  limits: Schema.Array(UsageLimitSchema),
  resetCredits: Schema.optional(
    Schema.Struct({
      availableCount: Schema.Number,
      nextCreditId: Schema.optional(Schema.String),
      credits: Schema.optional(Schema.Array(ResetCreditSchema)),
    }),
  ),
  notes: Schema.optional(Schema.Array(Schema.String)),
});

const UsageResponseSchema = Schema.Struct({
  generatedAt: Schema.Number,
  reports: Schema.Array(UsageReportSchema),
});

const decodeUsageResponse = Schema.decodeUnknownOption(UsageResponseSchema);

interface CachedProbe {
  readonly atMs: number;
  readonly limits: ServerProviderUsageLimits;
}

const probeCache = new Map<string, CachedProbe>();

export function clearNeoPiUsageProbeCache(): void {
  probeCache.clear();
}

interface UsageAmount {
  readonly used?: number;
  readonly limit?: number;
  readonly remaining?: number;
  readonly usedFraction?: number;
  readonly remainingFraction?: number;
  readonly unit?: string;
}

/**
 * Used fraction in 0..1 (values above 1 are overage). Precedence matches
 * NeoPi `packages/ai/src/usage.ts` `resolveUsedFraction`, plus `remaining/limit`
 * when the provider sent neither a used amount nor a fraction.
 */
export function resolveUsedFraction(amount: UsageAmount): number | undefined {
  if (isFiniteNumber(amount.usedFraction)) return amount.usedFraction;
  if (isFiniteNumber(amount.used) && isFiniteNumber(amount.limit) && amount.limit > 0) {
    return amount.used / amount.limit;
  }
  if (amount.unit === "percent" && isFiniteNumber(amount.used)) return amount.used / 100;
  if (isFiniteNumber(amount.remainingFraction)) return Math.max(0, 1 - amount.remainingFraction);
  if (isFiniteNumber(amount.remaining) && isFiniteNumber(amount.limit) && amount.limit > 0) {
    return (amount.limit - amount.remaining) / amount.limit;
  }
  return undefined;
}

export interface NeoPiUsageLimitsInput {
  readonly payload: unknown;
  readonly activeProvider: string;
  readonly checkedAt: string;
}

/**
 * Map one `npi usage --json` payload to the active provider's windows.
 * `metadata` and `raw` are dropped; they are not copied into labels or messages.
 * Returns undefined when the payload is not a usage report list.
 */
export function toUsageLimits(input: NeoPiUsageLimitsInput): ServerProviderUsageLimits | undefined {
  const reports = reportsForProvider(input.payload, input.activeProvider);
  if (reports === undefined) return undefined;
  if (reports.length === 0) {
    return makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "unsupported",
      message: "NeoPi/OMP has no usage windows for this provider.",
    });
  }
  // `--provider` filters reports, not accounts. Without an active-account RPC,
  // multiple credentials cannot be attributed to the current model safely.
  const accountsWithoutUsage =
    isRecord(input.payload) && Array.isArray(input.payload.accountsWithoutUsage)
      ? input.payload.accountsWithoutUsage
      : [];
  if (
    reports.length !== 1 ||
    accountsWithoutUsage.some(
      (account) =>
        isRecord(account) &&
        text(account.provider).toLowerCase() === input.activeProvider.toLowerCase(),
    )
  ) {
    return makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "unsupported",
      message: "NeoPi/OMP cannot attribute usage windows to the active account.",
    });
  }

  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const report of reports) {
    const provider = text(report.provider) || input.activeProvider;
    for (const limit of limitsOf(report)) {
      const window = windowFromLimit(limit, provider);
      if (window === undefined) continue;
      const existing = windows.get(window.id);
      if (existing === undefined || window.usedPercent > existing.usedPercent) {
        windows.set(window.id, window);
      }
    }
  }

  const resetCredits = resetCreditsFrom(reports);
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: windows.values() }),
    ...(resetCredits ? { resetCredits } : {}),
  };
}

export interface ApplyNeoPiUsageLimitsInput {
  readonly binary: string;
  readonly activeProvider: string;
  /** Active model's provider id. An empty id does not probe every account. */
  readonly profile?: string;
  readonly cwd: string;
  /** Full child environment. PATH must already be included; it is not inherited. */
  readonly environment?: Record<string, string>;
  /** Kept when the probe fails or times out. An unsupported provider replaces it. */
  readonly previous?: ServerProviderUsageLimits;
  readonly timeout?: Duration.Input;
  /**
   * Reads usage from a ready live session when one advertises `get_usage`.
   * `undefined` means no capable live session exists and permits the CLI fallback.
   */
  readonly getLiveUsage?: (activeProvider: string) => Effect.Effect<unknown | undefined, Error>;
}

type LiveUsageResult =
  | { readonly kind: "failed" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "available"; readonly payload: unknown };

/**
 * Read the active provider's usage from a capable live RPC session. When no
 * such session exists, probe `<bin> usage --json --redact --provider
 * <activeProvider>`. Failures keep the last good windows. Successful and
 * unsupported CLI results are cached for one minute.
 */
export const applyUsageLimits = Effect.fn("applyNeoPiUsageLimits")(function* (
  input: ApplyNeoPiUsageLimitsInput,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const activeProvider = input.activeProvider.trim();
  if (activeProvider === "") {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "NeoPi/OMP usage windows need the active model's provider.",
    });
  }

  if (input.getLiveUsage !== undefined) {
    const live: LiveUsageResult = yield* input.getLiveUsage(activeProvider).pipe(
      Effect.match({
        onFailure: (): LiveUsageResult => ({ kind: "failed" }),
        onSuccess: (payload): LiveUsageResult =>
          payload === undefined ? { kind: "unavailable" } : { kind: "available", payload },
      }),
    );
    if (live.kind === "failed") {
      const failed = makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "NeoPi/OMP usage request failed.",
      });
      return resolveUsageLimitsAfterProbe({ published: input.previous, probed: failed }) ?? failed;
    }
    if (live.kind === "available") {
      const decoded = decodeUsageResponse(live.payload);
      const mapped = Option.isSome(decoded)
        ? toUsageLimits({ payload: decoded.value, activeProvider, checkedAt })
        : undefined;
      const failed = makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "NeoPi/OMP usage request returned an invalid report.",
      });
      const probed = mapped ?? failed;
      return resolveUsageLimitsAfterProbe({ published: input.previous, probed }) ?? probed;
    }
  }

  const environmentHash = createHash("sha256");
  for (const [key, value] of Object.entries(input.environment ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    environmentHash.update(key).update("\0").update(value).update("\0");
  }
  const environmentIdentity = environmentHash.digest("hex");
  const cacheKey = [
    input.binary,
    input.profile?.trim() ?? "",
    activeProvider.toLowerCase(),
    input.cwd,
    environmentIdentity,
  ].join("\0");
  const nowMs = yield* DateTime.now.pipe(Effect.map((now) => DateTime.toEpochMillis(now)));
  const cached = probeCache.get(cacheKey);
  if (cached !== undefined && nowMs - cached.atMs < PROBE_CACHE_TTL_MS) {
    return withCheckedAt(cached.limits, checkedAt);
  }

  const failed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "NeoPi/OMP usage probe failed.",
  });
  const profile = input.profile?.trim();
  const probed = yield* spawnAndCollect(
    input.binary,
    ChildProcess.make(input.binary, ["usage", "--json", "--redact", "--provider", activeProvider], {
      cwd: input.cwd,
      env: {
        ...input.environment,
        ...(profile ? { OMP_PROFILE: profile } : {}),
      },
    }),
  ).pipe(
    Effect.timeoutOption(input.timeout ?? DEFAULT_PROBE_TIMEOUT),
    Effect.orElseSucceed(() => Option.none()),
    Effect.map((result) => {
      if (Option.isNone(result) || result.value.code !== 0) return failed;
      const mapped = toUsageLimits({
        payload: parseUsageJson(result.value.stdout),
        activeProvider,
        checkedAt,
      });
      return mapped ?? failed;
    }),
  );

  if (probed.unavailable?.reason !== "probeFailed") {
    probeCache.set(cacheKey, { atMs: nowMs, limits: probed });
  }
  return resolveUsageLimitsAfterProbe({ published: input.previous, probed }) ?? probed;
});

function withCheckedAt(
  limits: ServerProviderUsageLimits,
  checkedAt: string,
): ServerProviderUsageLimits {
  return limits.checkedAt === checkedAt ? limits : { ...limits, checkedAt };
}

const decodeUsageStdout = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function parseUsageJson(stdout: string): unknown {
  const decoded = decodeUsageStdout(stdout);
  return Option.isSome(decoded) ? decoded.value : undefined;
}

function reportsForProvider(
  payload: unknown,
  activeProvider: string,
): readonly Report[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.reports)) return undefined;
  const wanted = activeProvider.trim().toLowerCase();
  return payload.reports.filter(
    (report): report is Report =>
      isRecord(report) && text(report.provider).toLowerCase() === wanted,
  );
}

function windowFromLimit(
  limit: Record<string, unknown>,
  provider: string,
): ServerProviderUsageWindow | undefined {
  const id = text(limit.id);
  const label =
    text(limit.label) || text(isRecord(limit.window) ? limit.window.label : undefined) || id;
  if (id === "" || label.trim() === "") return undefined;
  const amount = isRecord(limit.amount) ? limit.amount : undefined;
  if (amount === undefined) return undefined;
  const fraction = resolveUsedFraction(amount as UsageAmount);
  if (fraction === undefined) return undefined;
  const window = isRecord(limit.window) ? limit.window : undefined;
  const durationMs = window?.durationMs;
  const durationMins =
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
      ? Math.round(durationMs / 60_000)
      : undefined;
  const resetsAt = isoFromEpochMillis(window?.resetsAt);
  return {
    id: `neopi:${provider}:${id}`,
    kind: kindForWindowId(text(window?.id)),
    label,
    usedPercent: clampPercent(fraction * 100),
    ...(resetsAt ? { resetsAt } : {}),
    ...(durationMins !== undefined ? { windowDurationMins: durationMins } : {}),
  };
}

function kindForWindowId(id: string): ServerProviderUsageWindow["kind"] {
  switch (id.toLowerCase()) {
    case "5h":
    case "session":
      return "session";
    case "7d":
    case "weekly":
      return "weekly";
    case "monthly":
      return "monthly";
    default:
      return "other";
  }
}

function resetCreditsFrom(
  reports: readonly Report[],
): ServerProviderUsageLimits["resetCredits"] | undefined {
  let count = 0;
  let present = false;
  let earliest: string | undefined;
  for (const report of reports) {
    const credits = report.resetCredits;
    if (
      !isRecord(credits) ||
      !isFiniteNumber(credits.availableCount) ||
      credits.availableCount < 0
    ) {
      continue;
    }
    present = true;
    count += Math.trunc(credits.availableCount);
    if (!Array.isArray(credits.credits)) continue;
    for (const credit of credits.credits) {
      if (!isRecord(credit)) continue;
      const expiresAt = text(credit.expiresAt);
      if (expiresAt !== "" && (earliest === undefined || expiresAt < earliest))
        earliest = expiresAt;
    }
  }
  if (!present) return undefined;
  return { availableCount: count, ...(earliest ? { nextExpiresAt: earliest } : {}) };
}

function limitsOf(report: Report): readonly Record<string, unknown>[] {
  return Array.isArray(report.limits) ? report.limits.filter(isRecord) : [];
}

function isoFromEpochMillis(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Report extends Record<string, unknown> {
  readonly provider?: unknown;
  readonly limits?: unknown;
  readonly resetCredits?: unknown;
}
