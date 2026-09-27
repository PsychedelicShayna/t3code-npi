import { rejects } from "node:assert/strict";
import { assert, it } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";
import { groupNeoPiHistory, rollbackNeoPiConversation } from "./NeoPiRollback.ts";
import type { NeoPiResumeCursor } from "./NeoPiRuntimeTypes.ts";

const user = (id: string, parentId: string | null, text: string) => ({
  id,
  parentId,
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});
const assistant = (id: string, parentId: string, text: string) => ({
  id,
  parentId,
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const entries = [
  user("first", null, "first prompt"),
  assistant("a1", "first", "first reply"),
  user("steer", "a1", "steer text"),
  assistant("a2", "steer", "steer reply"),
  user("second", "a2", "second prompt"),
  assistant("a3", "second", "second reply"),
  user("hidden", "a3", "extension user"),
  assistant("a4", "hidden", "extension reply"),
  user("third", "a4", "third prompt"),
  assistant("a5", "third", "third reply"),
];
const cursor: NeoPiResumeCursor = {
  v: 1,
  sessionFile: "/tmp/old.jsonl",
  sessionDir: "/tmp",
  sessionId: "old",
  turnBoundaries: ["first", "second", "third"].map((id, i) => ({
    turnId: TurnId.make(`turn-${i + 1}`),
    userEntryId: id,
  })),
};

for (const numTurns of [1, 3])
  it(`branches the captured user entry when rewinding ${numTurns} turns`, async () => {
    const sent: string[] = [];
    const target = numTurns === 1 ? "third" : "first";
    const parent = numTurns === 1 ? "a4" : null;
    const result = await rollbackNeoPiConversation({
      cursor,
      numTurns,
      request: async ({ type, entryId }) => {
        sent.push(`${type}:${entryId ?? ""}`);
        if (type === "get_entries") return { entries, leafId: sent.length === 4 ? parent : "a5" };
        if (type === "branch") return { cancelled: false, text: "removed" };
        return { sessionId: `new-${numTurns}`, sessionFile: `/tmp/new-${numTurns}.jsonl` };
      },
    });
    assert.deepEqual(sent, ["get_entries:", `branch:${target}`, "get_state:", "get_entries:"]);
    assert.equal(result.sessionFile, `/tmp/new-${numTurns}.jsonl`);
    assert.equal(result.sessionId, `new-${numTurns}`);
    assert.equal(result.turnBoundaries.length, 3 - numTurns);
    // The persisted cursor passed to the next runtime points at the new file, not the original.
    assert.notEqual(result.sessionFile, cursor.sessionFile);
  });

it("does not branch a missing ancestry entry, a hidden entry, or a cancelled request", async () => {
  for (const leafId of ["a1", "a5"]) {
    const sent: string[] = [];
    const suspect =
      leafId === "a1"
        ? cursor
        : {
            ...cursor,
            turnBoundaries: [
              ...cursor.turnBoundaries.slice(0, 2),
              { turnId: TurnId.make("hidden"), userEntryId: "missing" },
            ],
          };
    await rejects(
      rollbackNeoPiConversation({
        cursor: suspect,
        numTurns: 1,
        request: async ({ type }) => {
          sent.push(type);
          return { entries, leafId };
        },
      }),
      /active ancestry/,
    );
    assert.deepEqual(sent, ["get_entries"]);
  }
  const sent: string[] = [];
  await rejects(
    rollbackNeoPiConversation({
      cursor,
      numTurns: 1,
      request: async ({ type }) => {
        sent.push(type);
        return type === "get_entries" ? { entries, leafId: "a5" } : { cancelled: true };
      },
    }),
    /cancelled/,
  );
  assert.deepEqual(sent, ["get_entries", "branch"]);
  assert.equal(cursor.sessionFile, "/tmp/old.jsonl");
});

it("rejects stale post-branch state or an incorrect branch leaf", async () => {
  for (const failure of ["identity", "leaf"]) {
    const sent: string[] = [];
    await rejects(
      rollbackNeoPiConversation({
        cursor,
        numTurns: 1,
        request: async ({ type }) => {
          sent.push(type);
          if (type === "get_entries")
            return {
              entries,
              leafId:
                sent.length === 4 && failure === "leaf" ? "a5" : sent.length === 4 ? "a4" : "a5",
            };
          if (type === "branch") return { cancelled: false };
          return failure === "identity"
            ? { sessionId: "old", sessionFile: "/tmp/old.jsonl" }
            : { sessionId: "new", sessionFile: "/tmp/new.jsonl" };
        },
      }),
      failure === "identity" ? /branched session identity/ : /did not end before/,
    );
    assert.equal(cursor.sessionId, "old");
  }
});

it("groups steers and hidden extension messages with captured prompt turns", () => {
  const messages = entries.map((entry) => entry.message);
  const turns = groupNeoPiHistory(messages, entries, "a5", cursor);
  assert.deepEqual(
    turns.map((turn) => [turn.id, turn.items.length]),
    [
      [TurnId.make("turn-1"), 4],
      [TurnId.make("turn-2"), 4],
      [TurnId.make("turn-3"), 2],
    ],
  );
});

it("rewinds the next prompt without removing a prior steer", async () => {
  const throughSecond = entries.slice(0, 6);
  const twoTurns = { ...cursor, turnBoundaries: cursor.turnBoundaries.slice(0, 2) };
  let branchedLeaf = false;
  const retained = groupNeoPiHistory(
    throughSecond.map((entry) => entry.message),
    throughSecond,
    "a3",
    twoTurns,
  );
  assert.deepEqual(
    retained.map((turn) => turn.items.length),
    [4, 2],
  );
  const branched = await rollbackNeoPiConversation({
    cursor: twoTurns,
    numTurns: 1,
    request: async ({ type, entryId }) => {
      if (type === "get_entries")
        return { entries: throughSecond, leafId: branchedLeaf ? "a2" : "a3" };
      if (type === "branch") {
        assert.equal(entryId, "second");
        branchedLeaf = true;
        return { cancelled: false };
      }
      return { sessionId: "steer-branch", sessionFile: "/tmp/steer-branch.jsonl" };
    },
  });
  assert.deepEqual(
    branched.turnBoundaries.map((boundary) => boundary.userEntryId),
    ["first"],
  );
  const after = groupNeoPiHistory(
    throughSecond.slice(0, 4).map((entry) => entry.message),
    throughSecond,
    "a2",
    branched,
  );
  assert.deepEqual(
    after.map((turn) => turn.items.length),
    [4],
  );
});
