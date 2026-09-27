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
    const result = await rollbackNeoPiConversation({
      cursor,
      numTurns,
      request: async ({ type, entryId }) => {
        sent.push(`${type}:${entryId ?? ""}`);
        if (type === "get_entries") return { entries, leafId: "a5" };
        if (type === "branch") return { cancelled: false, text: "removed" };
        return { sessionId: `new-${numTurns}`, sessionFile: `/tmp/new-${numTurns}.jsonl` };
      },
    });
    assert.deepEqual(sent, ["get_entries:", `branch:${target}`, "get_state:"]);
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

it("accepts a carried label after branch and rejects stale session identity", async () => {
  const result = await rollbackNeoPiConversation({
    cursor,
    numTurns: 1,
    request: async ({ type }) => {
      if (type === "get_entries") return { entries, leafId: "a5" };
      if (type === "branch") return { cancelled: false };
      return { sessionId: "new", sessionFile: "/tmp/new.jsonl" };
    },
  });
  assert.equal(result.sessionId, "new");
  await rejects(
    rollbackNeoPiConversation({
      cursor,
      numTurns: 1,
      request: async ({ type }) => {
        if (type === "get_entries") return { entries, leafId: "a5" };
        if (type === "branch") return { cancelled: false };
        return { sessionId: "old", sessionFile: "/tmp/old.jsonl" };
      },
    }),
    /branched session identity/,
  );
});

it("rewinds local turns without mutating native history and branches only the first removed native turn", async () => {
  const mixed: NeoPiResumeCursor = {
    ...cursor,
    turnBoundaries: [
      cursor.turnBoundaries[0]!,
      { turnId: TurnId.make("local-B"), kind: "local" },
      cursor.turnBoundaries[1]!,
    ],
  };
  const requests: string[] = [];
  const request = async ({ type, entryId }: { type: string; entryId?: string }) => {
    requests.push(`${type}:${entryId ?? ""}`);
    if (type === "get_entries") return { entries, leafId: "a5" };
    if (type === "branch") return { cancelled: false };
    return { sessionId: "new", sessionFile: "/tmp/new.jsonl" };
  };
  const localLast = { ...mixed, turnBoundaries: mixed.turnBoundaries.slice(0, 2) };
  const withoutB = await rollbackNeoPiConversation({ cursor: localLast, numTurns: 1, request });
  assert.deepEqual(withoutB.turnBoundaries, [cursor.turnBoundaries[0]!]);
  assert.deepEqual(requests, []);
  const withoutC = await rollbackNeoPiConversation({ cursor: mixed, numTurns: 1, request });
  assert.equal(withoutC.turnBoundaries.length, 2);
  assert.ok(requests.includes("branch:second"));
  requests.length = 0;
  const withoutBC = await rollbackNeoPiConversation({ cursor: mixed, numTurns: 2, request });
  assert.deepEqual(withoutBC.turnBoundaries, [cursor.turnBoundaries[0]!]);
  assert.ok(requests.includes("branch:second"));
  await rejects(
    rollbackNeoPiConversation({
      cursor: {
        ...mixed,
        turnBoundaries: [...mixed.turnBoundaries, { turnId: TurnId.make("gap"), kind: "unknown" }],
      },
      numTurns: 2,
      request,
    }),
    /unknown native history/,
  );
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

it("groups converted custom, branch summary and compacted context without losing retained turns", () => {
  const custom = { id: "custom", parentId: "a1", type: "custom_message", content: "notice" };
  const summary = {
    id: "summary",
    parentId: "custom",
    type: "branch_summary",
    summary: "prior path",
  };
  const compaction = {
    id: "compact",
    parentId: "summary",
    type: "compaction",
    summary: "compressed",
  };
  const laterUser = user("later", "compact", "after compaction");
  const laterAssistant = assistant("later-answer", "later", "reply");
  const history = [
    entries[0]!,
    entries[1]!,
    custom,
    summary,
    compaction,
    laterUser,
    laterAssistant,
  ];
  const messages = [
    { role: "compactionSummary", summary: "compressed" },
    laterUser.message,
    laterAssistant.message,
  ];
  const turns = groupNeoPiHistory(messages, history, "later-answer", {
    ...cursor,
    turnBoundaries: [
      cursor.turnBoundaries[0]!,
      { turnId: TurnId.make("later-turn"), userEntryId: "later" },
    ],
  });
  assert.deepEqual(
    turns.map((turn) => [turn.id, turn.items.length]),
    [
      [TurnId.make("turn-1"), 1],
      [TurnId.make("later-turn"), 2],
    ],
  );
  const uncollapsed = groupNeoPiHistory(
    [
      entries[0]!.message,
      entries[1]!.message,
      { role: "custom", content: "notice" },
      { role: "branchSummary", summary: "prior path" },
    ],
    history,
    "summary",
    cursor,
  );
  assert.deepEqual(
    uncollapsed.map((turn) => turn.items.length),
    [4],
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
    branched.turnBoundaries.map((boundary) =>
      "userEntryId" in boundary ? boundary.userEntryId : boundary.kind,
    ),
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
