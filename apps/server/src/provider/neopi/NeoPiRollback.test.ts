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
    let branched = false;
    const result = await rollbackNeoPiConversation({
      cursor,
      numTurns,
      request: async ({ type, entryId }) => {
        sent.push(`${type}:${entryId ?? ""}`);
        if (type === "get_entries") return { entries, leafId: "a5" };
        if (type === "get_messages_page")
          return {
            messages: (branched
              ? entries.slice(
                  0,
                  entries.findIndex((entry) => entry.id === target),
                )
              : entries
            ).map((entry) => entry.message),
          };
        if (type === "branch") {
          branched = true;
          return { cancelled: false, text: "removed" };
        }
        return { sessionId: `new-${numTurns}`, sessionFile: `/tmp/new-${numTurns}.jsonl` };
      },
    });
    assert.deepEqual(sent, [
      "get_entries:",
      "get_messages_page:",
      `branch:${target}`,
      "get_state:",
      "get_messages_page:",
    ]);
    assert.equal(result.sessionFile, `/tmp/new-${numTurns}.jsonl`);
    assert.equal(result.sessionId, `new-${numTurns}`);
    assert.equal(result.turnBoundaries.length, 3 - numTurns);
    // The persisted cursor passed to the next runtime points at the new file, not the original.
    assert.notEqual(result.sessionFile, cursor.sessionFile);
  });

it("keeps a proposal refinement tied to its original native rollback boundary", async () => {
  const refined: NeoPiResumeCursor = {
    ...cursor,
    turnBoundaries: [
      { turnId: TurnId.make("proposal"), userEntryId: "first" },
      { turnId: TurnId.make("refinement"), kind: "continuation", afterEntryId: "proposal" },
    ],
  };
  const calls: string[] = [];
  await rejects(
    rollbackNeoPiConversation({
      cursor: refined,
      numTurns: 1,
      request: async (command) => {
        calls.push(command.type);
        return {};
      },
    }),
    /without its original native turn/,
  );
  assert.deepEqual(calls, [], "a continuation cannot be branched by itself");
  let branched = false;
  const planEntries = [
    user("first", null, "plan this"),
    assistant("proposal", "first", "# Plan"),
    assistant("refinement", "proposal", "Updated plan"),
  ];
  assert.deepEqual(
    groupNeoPiHistory(
      planEntries.map((entry) => entry.message),
      planEntries,
      "refinement",
      refined,
    ).map((turn) => ({ id: turn.id, count: turn.items.length })),
    [
      { id: "proposal", count: 2 },
      { id: "refinement", count: 1 },
    ],
  );
  const removed = await rollbackNeoPiConversation({
    cursor: refined,
    numTurns: 2,
    request: async ({ type, entryId }) => {
      calls.push(`${type}:${entryId ?? ""}`);
      if (type === "get_entries") return { entries: planEntries, leafId: "refinement" };
      if (type === "get_messages_page")
        return { messages: branched ? [] : planEntries.map((entry) => entry.message) };
      if (type === "branch") {
        branched = true;
        return { cancelled: false };
      }
      return { sessionId: "refined-branch", sessionFile: "/tmp/refined-branch.jsonl" };
    },
  });
  assert.equal(removed.sessionId, "refined-branch");
  assert.deepEqual(removed.turnBoundaries, []);
  assert.equal(calls.includes("branch:first"), true);
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
        if (type === "get_entries") return { entries, leafId: "a5" };
        if (type === "get_messages_page")
          return { messages: entries.map((entry) => entry.message) };
        return { cancelled: true };
      },
    }),
    /cancelled/,
  );
  assert.deepEqual(sent, ["get_entries", "get_messages_page", "branch"]);
  assert.equal(cursor.sessionFile, "/tmp/old.jsonl");
});

it("accepts a carried label after branch and rejects stale session identity", async () => {
  let branched = false;
  const result = await rollbackNeoPiConversation({
    cursor,
    numTurns: 1,
    request: async ({ type }) => {
      if (type === "get_entries") return { entries, leafId: "a5" };
      if (type === "get_messages_page")
        return {
          messages: (branched ? entries.slice(0, 8) : entries).map((entry) => entry.message),
        };
      if (type === "branch") {
        branched = true;
        return { cancelled: false };
      }
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
        if (type === "get_messages_page")
          return { messages: entries.map((entry) => entry.message) };
        if (type === "branch") return { cancelled: false };
        return { sessionId: "old", sessionFile: "/tmp/old.jsonl" };
      },
    }),
    /branched session identity/,
  );
});

it("persists the new identity before failing a branch that leaves removed messages in memory", async () => {
  let saved: NeoPiResumeCursor | undefined;
  await rejects(
    rollbackNeoPiConversation({
      cursor,
      numTurns: 1,
      request: async ({ type }) => {
        if (type === "get_entries") return { entries, leafId: "a5" };
        if (type === "get_messages_page")
          return { messages: entries.map((entry) => entry.message) };
        if (type === "branch") return { cancelled: false };
        return { sessionId: "new", sessionFile: "/tmp/new.jsonl" };
      },
      onBranched: async (next) => {
        saved = next;
      },
    }),
    /rollback integrity error: branched conversation still contains removed/,
  );
  assert.equal(saved?.sessionId, "new");
  assert.equal(saved?.sessionFile, "/tmp/new.jsonl");
  assert.deepEqual(saved?.turnBoundaries, cursor.turnBoundaries.slice(0, -1));
});

it("rejects unmatched native messages rather than attaching them to a retained turn", () => {
  assert.throws(
    () =>
      groupNeoPiHistory(
        [...entries.map((entry) => entry.message), { role: "user", content: "unmatched" }],
        entries,
        "a5",
        cursor,
      ),
    /unmatched native messages/,
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
  let branched = false;
  const request = async ({ type, entryId }: { type: string; entryId?: string }) => {
    requests.push(`${type}:${entryId ?? ""}`);
    if (type === "get_entries") return { entries, leafId: "a5" };
    if (type === "get_messages_page")
      return { messages: (branched ? entries.slice(0, 4) : entries).map((entry) => entry.message) };
    if (type === "branch") {
      branched = true;
      return { cancelled: false };
    }
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
  branched = false;
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

it("groups advertised entry ids even when native message content differs", () => {
  const custom = { id: "custom", parentId: "a1", type: "custom_message", content: "original" };
  const summary = { id: "compact", parentId: "custom", type: "compaction", summary: "old" };
  const next = user("next", "compact", "next prompt");
  const history = [entries[0]!, entries[1]!, custom, summary, next];
  const messages = [
    { entryId: "first", role: "user", content: "expanded prompt" },
    { entryId: "a1", role: "assistant", content: "transformed" },
    { entryId: "compact", role: "compactionSummary", summary: "new summary" },
    { entryId: "next", role: "user", content: "other text" },
  ];
  const grouped = groupNeoPiHistory(
    messages,
    history,
    "next",
    {
      ...cursor,
      turnBoundaries: [
        cursor.turnBoundaries[0]!,
        { turnId: TurnId.make("next-turn"), userEntryId: "next" },
      ],
    },
    true,
  );
  assert.deepEqual(
    grouped.map((turn) => [turn.id, turn.items.length]),
    [
      [TurnId.make("turn-1"), 3],
      [TurnId.make("next-turn"), 1],
    ],
  );
  assert.throws(
    () => groupNeoPiHistory([{ role: "user" }], history, "next", cursor, true),
    /unmatched native entry id/,
  );
  assert.throws(
    () => groupNeoPiHistory(messages, history, "next", cursor),
    /unmatched native messages/,
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
      if (type === "get_messages_page")
        return {
          messages: (branchedLeaf ? throughSecond.slice(0, 4) : throughSecond).map(
            (entry) => entry.message,
          ),
        };
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
