import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { useDatabase, db, denied, friend, setup } from "./social-fixture";
const { thread, conversationURL } = await import("../../src/server/feed");
const { addComment, createTitleComment, removeComment } =
  await import("../../src/server/comments");
const { setReaction } = await import("../../src/server/reactions");
const { createInvitation, revokeInvitation } =
  await import("../../src/server/invitations");

useDatabase();

type Statement = { text: string; values: unknown[] };
type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
};

// Records the statements that the server sends while `work` runs.
async function statements(work: () => Promise<unknown>) {
  const sent: Statement[] = [];
  const query = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const [text, values] = args;
    if (typeof text === "string")
      sent.push({ text, values: Array.isArray(values) ? values : [] });
    return (query as (...args: unknown[]) => unknown).apply(this, args);
  } as typeof query;
  try {
    await work();
  } finally {
    pg.Client.prototype.query = query;
  }
  return sent;
}

// Plans each data statement with the values the server used. Test tables are
// small enough that PostgreSQL may prefer a sequential scan even when an index
// applies, so sequential scans are disabled. The planner then reads each table
// through an index condition wherever one can serve the statement.
async function plans(sent: Statement[]) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    const result: PlanNode[] = [];
    for (const { text, values } of sent)
      if (/^\s*(SELECT|WITH|UPDATE|DELETE|INSERT)\b/i.test(text))
        result.push(
          (await client.query(`EXPLAIN (FORMAT JSON) ${text}`, values)).rows[0][
            "QUERY PLAN"
          ][0].Plan,
        );
    return result;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

// Bitmap index scans report their table on the heap scan above them.
function* nodes(
  node: PlanNode,
  heap?: string,
): Generator<PlanNode & { table?: string }> {
  const table =
    node["Relation Name"] ??
    (node["Node Type"].startsWith("Bitmap") ? heap : undefined);
  yield { ...node, table };
  for (const child of node.Plans ?? []) yield* nodes(child, table);
}

const entries = ["feed_item", "title_comment", "watch_progress", "review"];
const idTables = [...entries, "comment", "conversation", "invitation"];

// Checks that each listed table is read through an index on its `id` column,
// such as the primary key, and that no statement reads an ID-keyed table
// without an index condition.
async function assertIndexedLookups(
  name: string,
  work: () => Promise<unknown>,
  tables: string[],
) {
  const all = (await plans(await statements(work))).flatMap((plan) => [
    ...nodes(plan),
  ]);
  assert.deepEqual(
    all
      .filter(
        (node) =>
          idTables.includes(node.table ?? "") &&
          (node["Node Type"] === "Seq Scan" ||
            (/^Index (Only )?Scan$/.test(node["Node Type"]) &&
              !node["Index Cond"])),
      )
      .map((node) => `${node["Node Type"]} on ${node.table}`),
    [],
    `${name} reads no ID-keyed table in full`,
  );
  for (const table of tables)
    assert.ok(
      all.some(
        (node) =>
          node.table === table && /^\(id = /.test(node["Index Cond"] ?? ""),
      ),
      `${name} finds ${table} rows through an ID index`,
    );
}

// Adds a few hundred rows to each ID-keyed table. The other indexes that these
// statements could use, by owner, title, or entry, match most of them, so the
// ID is the selective condition, as in production. Fresh statistics then make
// the plans stable; near-empty tables leave the planner's choice arbitrary.
// Every row belongs to a member, so the next reset removes it.
async function fill(owner: string, reply: string) {
  await db.query(
    `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
     SELECT 'filler'||n,'Filler','filler'||n||'@example.test',true,now(),now()
     FROM generate_series(1,300) n`,
  );
  await db.query(
    `INSERT INTO profile(user_id,username,display_name)
     SELECT id,id,'Filler' FROM "user" WHERE id LIKE 'filler%'`,
  );
  await db.query(
    `INSERT INTO conversation(id,owner_id,title_id)
     SELECT gen_random_uuid(),user_id,'movie:1' FROM profile WHERE user_id LIKE 'filler%'`,
  );
  await db.query(
    `INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type)
     SELECT gen_random_uuid(),id,owner_id,title_id,'earlier' FROM conversation
     WHERE owner_id LIKE 'filler%'`,
  );
  await db.query(
    `INSERT INTO watch_progress(id,conversation_id,owner_id,title_id,status)
     SELECT gen_random_uuid(),id,owner_id,title_id,'watching' FROM conversation
     WHERE owner_id LIKE 'filler%'`,
  );
  await db.query(
    `INSERT INTO review(id,conversation_id,owner_id,title_id,rating)
     SELECT gen_random_uuid(),id,owner_id,title_id,3 FROM conversation
     WHERE owner_id LIKE 'filler%'`,
  );
  await db.query(
    `INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body,spoiler)
     SELECT gen_random_uuid(),id,owner_id,title_id,'Filler',false
     FROM conversation, generate_series(1,300) WHERE owner_id=$1 AND title_id='movie:1'`,
    [owner],
  );
  await db.query(
    `INSERT INTO comment(feed_item_id,conversation_id,author_id,body)
     SELECT feed_item_id,conversation_id,author_id,'Filler'
     FROM comment, generate_series(1,300) WHERE id=$1`,
    [reply],
  );
  await db.query(
    "INSERT INTO invitation(id,token_hash,creator_id) SELECT gen_random_uuid(),md5(n::text),$1 FROM generate_series(1,300) n",
    [owner],
  );
  await db.query(
    "ANALYZE conversation, feed_item, watch_progress, review, title_comment, comment, invitation",
  );
}

test("ID lookups compare native types so PostgreSQL uses ID indexes", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  const comment = await createTitleComment(alice, "movie:1", "Entry", false);
  const reply = await addComment(ben, conversation, "Reply", false);
  const { id: invitation } = await createInvitation(alice);
  await fill(alice, reply);
  await assertIndexedLookups(
    "thread",
    () => thread(alice, conversation),
    entries,
  );
  await assertIndexedLookups(
    "conversation link",
    () => conversationURL(alice, conversation, reply),
    ["conversation", ...entries],
  );
  await assertIndexedLookups(
    "reply",
    () => addComment(alice, conversation, "Nested", false, reply),
    [...entries, "comment"],
  );
  await assertIndexedLookups(
    "reaction",
    () => setReaction(ben, comment, undefined, "like"),
    entries,
  );
  await assertIndexedLookups("reply removal", () => removeComment(ben, reply), [
    "comment",
  ]);
  await assertIndexedLookups(
    "entry removal",
    () => removeComment(alice, comment),
    ["title_comment"],
  );
  await assertIndexedLookups(
    "invitation revocation",
    () => revokeInvitation(alice, invitation),
    ["invitation"],
  );
});

// PostgreSQL prints a uuid in lowercase with hyphens and a bigint without
// leading zeros. Text comparisons matched only those forms, so other spellings
// of an existing ID, and values that are not IDs at all, stay not found.
test("malformed or noncanonical IDs return the same not-found errors", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  const comment = await createTitleComment(alice, "movie:1", "Entry", false);
  const reply = await addComment(ben, conversation, "Reply", false);
  const { id: invitation } = await createInvitation(alice);
  const uuidSpellings = (id: string) => [
    id.toUpperCase(),
    `{${id}}`,
    id.replaceAll("-", ""),
    ` ${id}`,
  ];
  const malformed = ["", "not-an-id", "9223372036854775808"];
  for (const id of [...malformed, "1", ...uuidSpellings(conversation)]) {
    await assert.rejects(thread(alice, id), denied.conversation, id);
    await assert.rejects(conversationURL(alice, id), denied.conversation, id);
    await assert.rejects(
      addComment(ben, id, "Reply", false),
      denied.conversation,
      id,
    );
    await assert.rejects(
      setReaction(ben, id, undefined, "like"),
      denied.conversation,
      id,
    );
  }
  for (const id of ["9223372036854775808", "99999999999999999999", `0${reply}`])
    await assert.rejects(
      addComment(alice, conversation, "Nested", false, id),
      denied.replyTarget,
      id,
    );
  for (const id of [
    ...malformed,
    "-1",
    `0${reply}`,
    `+${reply}`,
    ...uuidSpellings(comment),
  ])
    await assert.rejects(removeComment(alice, id), denied.comment, id);
  for (const id of [...malformed, "1", ...uuidSpellings(invitation)])
    await assert.rejects(revokeInvitation(alice, id), denied.invitation, id);
  // The canonical IDs still work.
  assert.equal((await thread(alice, comment)).conversation.id, comment);
  await removeComment(alice, reply);
  await removeComment(alice, comment);
  await revokeInvitation(alice, invitation);
});
