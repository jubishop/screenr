import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  useDatabase,
  db,
  pending,
  person,
  friend,
  setup,
} from "./social-fixture";
const {
  createInvitation,
  completeSignup,
  invitationHash,
  revokeInvitation,
  listInvitations,
  activeInvitation,
} = await import("../../src/server/invitations");
const { changeRelationship, thread, profileFor, people } =
  await import("../../src/server/social");

useDatabase();

test("concurrent completed signups cannot exceed invitation capacity", async () => {
  const owner = await person("owner");
  const { token, id } = await createInvitation(owner, 1);
  const a = await pending("alice", token),
    b = await pending("ben", token);
  const results = await Promise.allSettled([
    completeSignup(a, "Alice", "alice"),
    completeSignup(b, "Ben", "ben"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (await db.query("SELECT uses FROM invitation WHERE id=$1", [id])).rows[0]
      .uses,
    1,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM profile")).rows[0].n,
    2,
  );
  const connections = (await people(owner)).connections;
  assert.equal(connections.length, 1);
  assert.ok(connections[0].accepted_at);
  assert.equal(
    connections[0].user_id,
    results[0].status === "fulfilled" ? a : b,
  );
});

test("profile failure rolls back invitation use; repeated completion consumes no extra use", async () => {
  const owner = await person("alice");
  const { token, id } = await createInvitation(owner, 2);
  const b = await pending("ben", token);
  await assert.rejects(completeSignup(b, "Ben", "alice"), /taken/);
  assert.equal(
    (await db.query("SELECT uses FROM invitation WHERE id=$1", [id])).rows[0]
      .uses,
    0,
  );
  assert.deepEqual((await people(owner)).connections, []);
  await completeSignup(b, "Ben", "ben");
  await completeSignup(b, "Ben", "ben");
  assert.equal(
    (await db.query("SELECT uses FROM invitation WHERE id=$1", [id])).rows[0]
      .uses,
    1,
  );
  assert.equal((await people(owner)).connections.length, 1);
  assert.ok((await profileFor(b, "alice")).accepted_at);
});

test("invitation lifetime, revocation, ownership, limits, and email verification are enforced", async () => {
  const owner = await person("owner"),
    other = await person("other");
  for (const limit of [0, 13, 1.5, "2"])
    await assert.rejects(createInvitation(owner, limit));
  const { token, id } = await createInvitation(owner);
  const a = await pending("alice", token, false);
  await assert.rejects(completeSignup(a, "Alice", "alice"), /Verify/);
  await db.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [a]);
  await assert.rejects(revokeInvitation(other, id), /not found/);
  const span = (
    await db.query(
      "SELECT extract(epoch FROM expires_at-created_at)::int AS seconds FROM invitation WHERE id=$1",
      [id],
    )
  ).rows[0].seconds;
  assert.equal(span, 30 * 86400);
  await db.query(
    "UPDATE invitation SET expires_at=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  await assert.rejects(completeSignup(a, "Alice", "alice"), /no longer/);
  await db.query(
    "UPDATE invitation SET expires_at=now()+interval '1 day' WHERE id=$1",
    [id],
  );
  await revokeInvitation(owner, id);
  await assert.rejects(completeSignup(a, "Alice", "alice"), /no longer/);
  assert.deepEqual((await people(owner)).connections, []);
});

test("completed signups become accepted friends with only their inviter and retain normal access controls", async () => {
  const { alice: owner, conversation } = await setup();
  assert.deepEqual(
    (await people(owner)).connections,
    [],
    "Bootstrap has no inviter",
  );
  const { token } = await createInvitation(owner, 3);
  const a = await pending("guesta", token);
  assert.deepEqual(
    (await people(owner)).connections,
    [],
    "Pending signup is not a friend",
  );
  await Promise.all([
    completeSignup(a, "Guest A", "guesta"),
    completeSignup(a, "Guest A", "guesta"),
  ]);
  const b = await pending("guestb", token);
  await completeSignup(b, "Guest B", "guestb");
  for (const [guest, username] of [
    [a, "guesta"],
    [b, "guestb"],
  ]) {
    const inviter = await profileFor(guest, "alice");
    assert.equal(inviter.can_read, true);
    assert.ok(inviter.accepted_at);
    assert.equal((await profileFor(owner, username)).can_read, true);
    assert.deepEqual(
      (await people(guest)).connections.map((p) => p.user_id),
      [owner],
    );
    assert.equal(
      (await thread(guest, conversation)).conversation.id,
      conversation,
    );
  }
  assert.equal((await people(owner)).connections.length, 2);
  assert.equal((await profileFor(a, "guestb")).can_read, false);
  assert.equal((await listInvitations(owner))[0].uses, 2);
  assert.deepEqual(
    (await listInvitations(owner))[0].joined
      .map((p: { username: string }) => p.username)
      .sort(),
    ["guesta", "guestb"],
  );
  await changeRelationship(a, owner, "remove");
  await completeSignup(a, "Guest A", "guesta", token);
  assert.equal((await profileFor(a, "alice")).can_read, false);
  await assert.rejects(thread(a, conversation), /not found/i);
  await friend(a, owner);
  await changeRelationship(a, owner, "block");
  await completeSignup(a, "Guest A", "guesta", token);
  await assert.rejects(profileFor(a, "alice"), /not found/i);
  await assert.rejects(thread(a, conversation), /not found/i);
  assert.deepEqual((await people(a)).connections, []);
  assert.deepEqual(
    (await listInvitations(owner))[0].joined.map(
      (p: { username: string }) => p.username,
    ),
    ["guestb"],
  );
  assert.equal((await listInvitations(owner))[0].uses, 2);
});

test("active invitations expose stable working links only to their creator", async () => {
  const owner = await person("owner"),
    other = await person("other");
  const invitation = await createInvitation(owner, 2);
  const first = (await listInvitations(owner))[0];
  assert.equal(first.url, `http://localhost:3000/join/${invitation.token}`);
  assert.equal((await listInvitations(owner))[0].url, first.url);
  assert.deepEqual(await listInvitations(other), []);
  assert.deepEqual(await activeInvitation(invitationHash(invitation.token)), {
    id: invitation.id,
  });
  const member = await pending("newmember", invitation.token);
  await completeSignup(member, "New member", "newmember", invitation.token);
  const remaining = (await listInvitations(owner))[0];
  assert.equal(remaining.url, first.url);
  assert.equal(remaining.uses, 1);
  assert.equal(remaining.max_uses, 2);
  assert.equal(remaining.joined[0].username, "newmember");
});

test("old invitations gain a working share link without breaking the original or resetting capacity", async () => {
  const owner = await person("owner");
  const original = randomBytes(32).toString("base64url"),
    id = randomUUID();
  // Model a pre-upgrade row: only the original one-way hash exists.
  await db.query(
    "INSERT INTO invitation(id,token_hash,creator_id,max_uses) VALUES($1,$2,$3,2)",
    [id, invitationHash(original), owner],
  );
  const listed = (await listInvitations(owner))[0];
  assert.equal(typeof listed.url, "string");
  const shared = new URL(listed.url).pathname.split("/").at(-1)!;
  assert.match(shared, /^[a-zA-Z0-9_-]{43}$/);
  assert.notEqual(shared, original);
  assert.equal((await listInvitations(owner))[0].url, listed.url);
  for (const token of [original, shared])
    assert.deepEqual(await activeInvitation(invitationHash(token)), { id });
  const first = await pending("originalguest", original);
  await completeSignup(first, "Original guest", "originalguest");
  assert.equal((await listInvitations(owner))[0].uses, 1);
  const second = await pending("sharedguest", shared);
  await completeSignup(second, "Shared guest", "sharedguest", shared);
  for (const guest of [first, second]) {
    assert.equal((await profileFor(guest, "owner")).can_read, true);
    assert.ok((await profileFor(guest, "owner")).accepted_at);
  }
  assert.deepEqual(await listInvitations(owner), []);
  for (const token of [original, shared])
    assert.equal(await activeInvitation(invitationHash(token)), undefined);
  assert.equal(
    (await db.query("SELECT uses FROM invitation WHERE id=$1", [id])).rows[0]
      .uses,
    2,
  );
});

test("revoked, expired, and exhausted invitations disappear while their records remain", async () => {
  const owner = await person("owner");
  const active = await createInvitation(owner);
  const revoked = await createInvitation(owner);
  const expired = await createInvitation(owner);
  const exhausted = await createInvitation(owner);
  await revokeInvitation(owner, revoked.id);
  await db.query("UPDATE invitation SET expires_at=now() WHERE id=$1", [
    expired.id,
  ]);
  const guest = await pending("guest", exhausted.token);
  await completeSignup(guest, "Guest", "guest");
  assert.deepEqual(
    (await listInvitations(owner)).map((item) => item.id),
    [active.id],
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM invitation WHERE creator_id=$1",
        [owner],
      )
    ).rows[0].n,
    4,
  );
});

for (const condition of ["revoked", "expired"]) {
  test(`both URLs of an old ${condition} invitation reject new signups`, async () => {
    const owner = await person("owner");
    const original = randomBytes(32).toString("base64url"),
      id = randomUUID();
    await db.query(
      "INSERT INTO invitation(id,token_hash,creator_id,max_uses) VALUES($1,$2,$3,2)",
      [id, invitationHash(original), owner],
    );
    const listed = (await listInvitations(owner))[0];
    assert.equal(typeof listed.url, "string");
    const shared = new URL(listed.url).pathname.split("/").at(-1)!;
    const guest = await pending("guest", shared);
    if (condition === "revoked") await revokeInvitation(owner, id);
    else
      await db.query("UPDATE invitation SET expires_at=now() WHERE id=$1", [
        id,
      ]);
    assert.deepEqual(await listInvitations(owner), []);
    for (const token of [original, shared]) {
      assert.equal(await activeInvitation(invitationHash(token)), undefined);
      await assert.rejects(
        completeSignup(guest, "Guest", "guest", token),
        /no longer/,
      );
    }
  });
}

test("replacement invitations authorize pending accounts and retain completion idempotency", async () => {
  const originalOwner = await person("originalowner");
  const replacementOwner = await person("replacementowner");
  const original = await createInvitation(originalOwner);
  const replacement = await createInvitation(replacementOwner);
  const user = await pending("replacement", original.token);
  await db.query("UPDATE invitation SET revoked_at=now() WHERE id=$1", [
    original.id,
  ]);
  await completeSignup(user, "Replacement", "replacement", replacement.token);
  await completeSignup(user, "Replacement", "replacement", original.token);
  assert.deepEqual((await people(originalOwner)).connections, []);
  assert.deepEqual(
    (await people(user)).connections.map((p) => p.user_id),
    [replacementOwner],
  );
  assert.equal((await profileFor(user, "replacementowner")).can_read, true);
  assert.ok((await profileFor(replacementOwner, "replacement")).accepted_at);
  const uses = (
    await db.query("SELECT id,uses FROM invitation WHERE id=ANY($1::uuid[])", [
      [original.id, replacement.id],
    ])
  ).rows;
  assert.equal(uses.find((row) => row.id === original.id).uses, 0);
  assert.equal(uses.find((row) => row.id === replacement.id).uses, 1);
  assert.equal(
    (
      await db.query(
        "SELECT invitation_id FROM invitation_signup WHERE user_id=$1",
        [user],
      )
    ).rows[0].invitation_id,
    replacement.id,
  );
});

test("replacement invitations preserve verification, availability, and rollback checks", async () => {
  for (const condition of [
    "unverified",
    "revoked",
    "expired",
    "exhausted",
  ] as const) {
    const original = await createInvitation(null);
    const replacement = await createInvitation(null);
    const user = await pending(
      condition,
      original.token,
      condition !== "unverified",
    );
    if (condition === "revoked")
      await db.query("UPDATE invitation SET revoked_at=now() WHERE id=$1", [
        replacement.id,
      ]);
    if (condition === "expired")
      await db.query(
        "UPDATE invitation SET expires_at=now()-interval '1 second' WHERE id=$1",
        [replacement.id],
      );
    if (condition === "exhausted")
      await db.query("UPDATE invitation SET uses=max_uses WHERE id=$1", [
        replacement.id,
      ]);
    await assert.rejects(
      completeSignup(user, condition, condition, replacement.token),
      /Verify|no longer/,
    );
    assert.equal(
      (await db.query("SELECT uses FROM invitation WHERE id=$1", [original.id]))
        .rows[0].uses,
      0,
    );
    assert.equal(
      (await db.query("SELECT 1 FROM profile WHERE user_id=$1", [user]))
        .rowCount,
      0,
    );
  }
  await person("takenhandle");
  const original = await createInvitation(null);
  const replacement = await createInvitation(null);
  const user = await pending("conflict", original.token);
  await assert.rejects(
    completeSignup(user, "Conflict", "takenhandle", replacement.token),
    /taken/,
  );
  assert.equal(
    (
      await db.query("SELECT uses FROM invitation WHERE id=$1", [
        replacement.id,
      ])
    ).rows[0].uses,
    0,
  );
});

test("concurrent replacement signups cannot exceed the replacement invitation's capacity", async () => {
  const original = await createInvitation(null, 2);
  const replacement = await createInvitation(null, 1);
  const a = await pending("replacementa", original.token),
    b = await pending("replacementb", original.token);
  const results = await Promise.allSettled([
    completeSignup(a, "A", "replacementa", replacement.token),
    completeSignup(b, "B", "replacementb", replacement.token),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    (
      await db.query("SELECT uses FROM invitation WHERE id=$1", [
        replacement.id,
      ])
    ).rows[0].uses,
    1,
  );
  assert.equal(
    (await db.query("SELECT uses FROM invitation WHERE id=$1", [original.id]))
      .rows[0].uses,
    0,
  );
});
