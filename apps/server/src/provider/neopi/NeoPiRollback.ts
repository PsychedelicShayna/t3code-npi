// @effect-diagnostics nodeBuiltinImport:off -- compare branched session identities with Node path resolution.
import { resolve } from "node:path";
import { TurnId } from "@t3tools/contracts";
import type { NeoPiResumeCursor } from "./NeoPiRuntimeTypes.ts";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export class NeoPiRollbackError extends Error {}

/** NeoPi branch takes the user entry to REMOVE, not the entry preceding it. */
export async function rollbackNeoPiConversation(input: {
  cursor: NeoPiResumeCursor;
  numTurns: number;
  request: (command: { type: string; entryId?: string }) => Promise<unknown>;
}): Promise<NeoPiResumeCursor> {
  const { cursor, numTurns, request } = input;
  if (!Number.isSafeInteger(numTurns) || numTurns < 1 || numTurns > cursor.turnBoundaries.length)
    throw new NeoPiRollbackError("rollback unavailable for turns before boundary capture");
  const target = cursor.turnBoundaries[cursor.turnBoundaries.length - numTurns]!;
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
  const after = object(await request({ type: "get_entries" }));
  if (after.leafId !== selected.parentId || !Array.isArray(after.entries))
    throw new NeoPiRollbackError("NeoPi/OMP branch did not end before the removed user entry");
  return {
    ...cursor,
    sessionFile: resolve(state.sessionFile),
    sessionId: state.sessionId,
    turnBoundaries: cursor.turnBoundaries.slice(0, -numTurns),
  };
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
    cursor.turnBoundaries.map((boundary) => [boundary.userEntryId, boundary.turnId]),
  );
  const turns: Array<{ id: TurnId; items: unknown[] }> = [];
  let messageIndex = 0;
  for (const entry of ancestry) {
    if (entry.type !== "message" && entry.type !== "custom_message") continue;
    const native = object(entry.message);
    const message = object(messages[messageIndex]);
    // get_messages_page contains display transformations (custom messages, compaction).
    // Match persisted messages by role/content to avoid treating hidden user entries as turns.
    if (
      entry.type !== "message" ||
      native.role !== message.role ||
      JSON.stringify(native.content) !== JSON.stringify(message.content)
    )
      continue;
    const turnId = boundaries.get(String(entry.id));
    if (turnId) turns.push({ id: turnId, items: [] });
    if (turns.length === 0) turns.push({ id: TurnId.make("neopi-history-1"), items: [] });
    turns[turns.length - 1]!.items.push(messages[messageIndex]);
    messageIndex++;
  }
  if (messageIndex !== messages.length)
    throw new NeoPiRollbackError(
      "NeoPi/OMP history does not align with persisted entry boundaries",
    );
  return turns;
}
