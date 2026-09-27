// @effect-diagnostics nodeBuiltinImport:off -- compare branched session identities with Node path resolution.
import { resolve } from "node:path";
import { TurnId } from "@t3tools/contracts";
import type { NeoPiResumeCursor } from "./NeoPiRuntimeTypes.ts";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export class NeoPiRollbackError extends Error {}
export class NeoPiRollbackIntegrityError extends NeoPiRollbackError {}

/** NeoPi branch takes the user entry to REMOVE, not the entry preceding it. */
export async function rollbackNeoPiConversation(input: {
  cursor: NeoPiResumeCursor;
  numTurns: number;
  request: (command: { type: string; entryId?: string }) => Promise<unknown>;
  onBranched?: (cursor: NeoPiResumeCursor) => Promise<void>;
}): Promise<NeoPiResumeCursor> {
  const { cursor, numTurns, request, onBranched } = input;
  if (!Number.isSafeInteger(numTurns) || numTurns < 1 || numTurns > cursor.turnBoundaries.length)
    throw new NeoPiRollbackError("rollback unavailable for turns before boundary capture");
  const removed = cursor.turnBoundaries.slice(-numTurns);
  if (removed.some((turn) => "kind" in turn && turn.kind === "unknown"))
    throw new NeoPiRollbackError("rollback unavailable across a turn with unknown native history");
  const target = removed.find(
    (turn): turn is Extract<typeof turn, { userEntryId: string }> => "userEntryId" in turn,
  );
  if (!target) return { ...cursor, turnBoundaries: cursor.turnBoundaries.slice(0, -numTurns) };
  const { entries, leafId } = object(await request({ type: "get_entries" }));
  if (!Array.isArray(entries) || !(typeof leafId === "string" || leafId === null))
    throw new NeoPiRollbackError("NeoPi/OMP did not return a valid entry ancestry");
  const byId = new Map<string, Record<string, unknown>>();
  for (const value of entries) {
    const entry = object(value);
    if (typeof entry.id !== "string" || byId.has(entry.id))
      throw new NeoPiRollbackError("NeoPi/OMP returned duplicate or invalid entry IDs");
    byId.set(entry.id, entry);
  }
  let id = leafId;
  const seen = new Set<string>();
  let selected: Record<string, unknown> | undefined;
  while (id !== null) {
    if (seen.has(id)) throw new NeoPiRollbackError("NeoPi/OMP entry ancestry contains a cycle");
    seen.add(id);
    const entry = byId.get(id);
    if (!entry || !(typeof entry.parentId === "string" || entry.parentId === null))
      throw new NeoPiRollbackError("NeoPi/OMP entry ancestry is incomplete");
    if (id === target.userEntryId) selected = entry;
    id = entry.parentId;
  }
  if (!selected || selected.type !== "message" || object(selected.message).role !== "user")
    throw new NeoPiRollbackError("Rollback boundary is not a user entry on the active ancestry");

  const before = await readMessages(request);
  const grouped = groupNeoPiHistory(before, entries, leafId, cursor);
  const firstRemoved = grouped.findIndex((turn) => turn.id === target.turnId);
  if (firstRemoved < 0)
    throw new NeoPiRollbackError("Rollback boundary is missing from native conversation history");
  const retained = grouped.slice(0, firstRemoved).flatMap((turn) => turn.items);

  const branch = object(await request({ type: "branch", entryId: target.userEntryId }));
  if (branch.cancelled !== false)
    throw new NeoPiRollbackError("NeoPi/OMP cancelled conversation rollback");
  const state = object(await request({ type: "get_state" }));
  if (
    typeof state.sessionFile !== "string" ||
    !state.sessionFile ||
    typeof state.sessionId !== "string" ||
    !state.sessionId ||
    resolve(state.sessionFile) === resolve(cursor.sessionFile) ||
    state.sessionId === cursor.sessionId
  )
    throw new NeoPiRollbackError("NeoPi/OMP did not report the branched session identity");
  const next = {
    ...cursor,
    sessionFile: resolve(state.sessionFile),
    sessionId: state.sessionId,
    turnBoundaries: cursor.turnBoundaries.slice(0, -numTurns),
  };
  // Save the branch identity before checking the live conversation; the adapter
  // can then restart on the original cursor if the new session proves inconsistent.
  await onBranched?.(next);
  try {
    const after = await readMessages(request);
    if (JSON.stringify(after) !== JSON.stringify(retained))
      throw new NeoPiRollbackIntegrityError(
        "NeoPi/OMP rollback integrity error: branched conversation still contains removed or unexpected messages",
      );
  } catch (cause) {
    if (cause instanceof NeoPiRollbackIntegrityError) throw cause;
    throw new NeoPiRollbackIntegrityError(
      `NeoPi/OMP rollback integrity error: cannot verify branched conversation: ${String(cause)}`,
    );
  }
  return next;
}

async function readMessages(
  request: (command: { type: string; cursor?: string }) => Promise<unknown>,
): Promise<unknown[]> {
  const messages: unknown[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = object(
      await request({ type: "get_messages_page", ...(cursor ? { cursor } : {}) }),
    );
    if (!Array.isArray(page.messages))
      throw new NeoPiRollbackError("NeoPi/OMP did not return a valid conversation page");
    messages.push(...page.messages);
    cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
    if (cursor && seen.has(cursor))
      throw new NeoPiRollbackError("NeoPi/OMP conversation pagination contains a cycle");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return messages;
}

/** Align native history with captured prompt boundaries, not every user message (steers/extensions). */
export function groupNeoPiHistory(
  messages: ReadonlyArray<unknown>,
  entriesValue: unknown,
  leafValue: unknown,
  cursor: NeoPiResumeCursor,
): Array<{ id: TurnId; items: unknown[] }> {
  if (!Array.isArray(entriesValue) || !(typeof leafValue === "string" || leafValue === null))
    throw new NeoPiRollbackError("NeoPi/OMP did not return a valid transcript ancestry");
  const byId = new Map<string, Record<string, unknown>>();
  for (const value of entriesValue) {
    const entry = object(value);
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const ancestry: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let id = leafValue;
  while (id !== null) {
    if (seen.has(id))
      throw new NeoPiRollbackError("NeoPi/OMP transcript ancestry contains a cycle");
    seen.add(id);
    const entry = byId.get(id);
    if (!entry || !(typeof entry.parentId === "string" || entry.parentId === null))
      throw new NeoPiRollbackError("NeoPi/OMP transcript ancestry is incomplete");
    ancestry.push(entry);
    id = entry.parentId;
  }
  ancestry.reverse();
  const boundaries = new Map(
    cursor.turnBoundaries.flatMap((boundary) =>
      "userEntryId" in boundary ? [[boundary.userEntryId, boundary.turnId] as const] : [],
    ),
  );
  const turns: Array<{ id: TurnId; items: unknown[] }> = [];
  let messageIndex = 0;
  for (const entry of ancestry) {
    const turnId = boundaries.get(String(entry.id));
    if (turnId) turns.push({ id: turnId, items: [] });
    if (messageIndex >= messages.length) continue;
    const message = object(messages[messageIndex]);
    const native = object(entry.message);
    const direct =
      entry.type === "message" &&
      native.role === message.role &&
      JSON.stringify(native.content) === JSON.stringify(message.content);
    const converted =
      (entry.type === "custom_message" && message.role === "custom") ||
      (entry.type === "branch_summary" && message.role === "branchSummary") ||
      (entry.type === "compaction" && message.role === "compactionSummary");
    if (!direct && !converted) continue;
    if (turns.length === 0) turns.push({ id: TurnId.make("neopi-history-1"), items: [] });
    turns[turns.length - 1]!.items.push(messages[messageIndex++]);
  }
  if (messageIndex !== messages.length)
    throw new NeoPiRollbackError("NeoPi/OMP transcript contains unmatched native messages");
  return turns;
}
