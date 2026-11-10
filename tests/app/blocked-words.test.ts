import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, db, cookieFor, pending, setup } from "./social-fixture";
const { blockedWords } = await import("../../src/server/blocked-words");
const { hasBlockedWord } = await import("../../src/server/word-filter");
const { createInvitation } = await import("../../src/server/invitations");
const { POST } = await import("../../src/app/api/screenr/[action]/route");

// The blocked-word filter (docs/data-and-access.md#blocked-words). These
// cases name a few of the list's words to show how matching reads them.

useDatabase();

test("the filter matches whole words and phrases, ignoring case, accents, and hidden characters, with look-alikes and plural endings", () => {
  for (const text of [
    "nigger",
    "NIGGER",
    "Nígger",
    "ｎｉｇｇｅｒ",
    "nig\u200bger",
    "nig\u00adger",
    "n1gg3r",
    "N!GG3R",
    "a nigger's",
    "(nigger)",
    "#nigger!",
    "big_nigger",
    "f@ggot",
    "f4gg0t",
    "fags",
    "$pic",
    "sp!c",
    "k1ke",
    "kikes",
    "trannies",
    "spazzes",
    "retards",
    "porch monkey",
    "Porch-Monkeys",
    "porchmonkey",
    "blow job",
    "BLOWJOBS",
    "b10wj0b",
    "b1ow job",
    "b|ow-job",
    "blow_job",
    "Blow ‐ job",
    // A compound's spaced and hyphenated spellings, as in the dictionary.
    "gang bang",
    "Gang-Bang",
    "rim job",
    "cum shots",
    // Digits around a word don't join it, as in a username, including the
    // words of a phrase.
    "nigger99",
    "2nigger",
    "porch_monkey99",
    "69blow_job",
    "One long gangbang of a finale.",
  ])
    assert.equal(hasBlockedWord(text), true, text);
  for (const text of [
    "",
    "snigger",
    "niggardly",
    "Scunthorpe",
    "spicy",
    "spices",
    "Japan",
    "Japanese",
    "japes",
    "Pakistani",
    "retardant",
    "raccoon",
    "heebie-jeebies",
    "The Dick Van Dyke Show",
    "Queer Eye",
    "a job to blow off",
    // Other punctuation, such as a comma, period, or line break, ends a
    // phrase, and so does an exclamation mark before a space.
    "On the other hand, job hunting is brutal.",
    "It was a low blow. Job done, though.",
    "Give him a hand\nJob well done",
    "Lend a hand! Job well done.",
    "This show is batty!! Boy, did I laugh.",
    "porch",
    "monkey",
    "Fuck this shit, it's a shitty finale.",
    "1990",
    "@alice",
    "covid19",
    "s01e02",
    "4chan",
  ])
    assert.equal(hasBlockedWord(text), false, text);
});

test("every list entry is blocked, with a phrase's words spaced, hyphenated, or joined, also in a username with digits around it, and the list holds each entry once in lowercase", () => {
  assert.ok(blockedWords.length > 0);
  assert.equal(new Set(blockedWords).size, blockedWords.length);
  for (const entry of blockedWords) {
    assert.equal(entry, entry.toLowerCase().trim(), entry);
    assert.equal(hasBlockedWord(`Some ${entry.toUpperCase()}.`), true, entry);
    for (const spelling of [" ", "-", ""])
      assert.equal(
        hasBlockedWord(entry.replaceAll(" ", spelling)),
        true,
        entry,
      );
    const username = `99${entry.replaceAll(" ", "_")}99`;
    assert.equal(hasBlockedWord(username), true, username);
  }
});

// Ordinary text, with words that contain a blocked word, passes everywhere.
const ordinary = "The spicy finale made me snigger in Scunthorpe.";
const refused = "That finale was one long gangbang.";
const refusal = (label: string) => ({
  error: `${label} contains a word Screenr doesn’t allow.`,
});

function sender(cookie: string) {
  return async (action: string, data: unknown) => {
    const response = await POST(
      new Request(`http://localhost:3000/api/screenr/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          Cookie: cookie,
        },
        body: JSON.stringify(data),
      }),
      { params: Promise.resolve({ action }) },
    );
    return { status: response.status, body: await response.json() };
  };
}

const count = async (table: string, column: string, value: string) =>
  Number(
    (
      await db.query(
        `SELECT count(*) AS count FROM ${table} WHERE ${column}=$1`,
        [value],
      )
    ).rows[0].count,
  );

test("posts, title comments, replies, and reviews refuse a blocked word, store nothing, and accept ordinary text", async () => {
  const { alice, conversation } = await setup();
  const send = sender(await cookieFor(alice));

  const post = { body: refused, spoiler: false };
  assert.deepEqual(await send("discussion-post", post), {
    status: 400,
    body: refusal("Post"),
  });
  assert.equal(await count("discussion_post", "owner_id", alice), 0);
  assert.equal(
    (await send("discussion-post", { ...post, body: ordinary })).status,
    200,
  );
  assert.equal(await count("discussion_post", "owner_id", alice), 1);

  const comment = { title: "movie:1", body: refused, spoiler: false };
  assert.deepEqual(await send("title-comment", comment), {
    status: 400,
    body: refusal("Comment"),
  });
  assert.equal(await count("title_comment", "owner_id", alice), 0);
  assert.equal(
    (await send("title-comment", { ...comment, body: ordinary })).status,
    200,
  );
  assert.equal(await count("title_comment", "owner_id", alice), 1);

  const reply = { conversation, body: refused, spoiler: false };
  assert.deepEqual(await send("comment", reply), {
    status: 400,
    body: refusal("Reply"),
  });
  assert.equal(await count("comment", "author_id", alice), 0);
  const { body: posted } = await send("comment", { ...reply, body: ordinary });
  assert.equal(await count("comment", "author_id", alice), 1);
  // A nested reply follows the same rule.
  assert.deepEqual(await send("comment", { ...reply, replyTo: posted.id }), {
    status: 400,
    body: refusal("Reply"),
  });
  assert.equal(await count("comment", "author_id", alice), 1);

  const review = { title: "movie:1", rating: 4, body: refused, spoiler: false };
  assert.deepEqual(await send("review", review), {
    status: 400,
    body: refusal("Review"),
  });
  assert.equal(await count("review", "owner_id", alice), 0);
  assert.equal(
    (await send("review", { ...review, body: ordinary })).status,
    200,
  );
  // Editing a saved review follows the same rule and keeps the saved text.
  assert.deepEqual(await send("review", { ...review, rating: 5 }), {
    status: 400,
    body: refusal("Review"),
  });
  assert.deepEqual(
    (
      await db.query("SELECT rating,body FROM review WHERE owner_id=$1", [
        alice,
      ])
    ).rows,
    [{ rating: 4, body: ordinary }],
  );
});

test("display name and username changes refuse a blocked word, change nothing, and accept ordinary names", async () => {
  const { alice } = await setup();
  const send = sender(await cookieFor(alice));
  const names = async () =>
    (
      await db.query(
        "SELECT display_name,username FROM profile WHERE user_id=$1",
        [alice],
      )
    ).rows[0];

  assert.deepEqual(await send("display-name", { name: "Big Gangbang" }), {
    status: 400,
    body: refusal("Display name"),
  });
  assert.deepEqual(
    await send("profile", { name: "F4gg0t Fan", username: "alice" }),
    { status: 400, body: refusal("Display name") },
  );
  assert.deepEqual(
    await send("profile", { name: "Alice", username: "big_gangbang" }),
    { status: 400, body: refusal("Username") },
  );
  assert.deepEqual(await names(), { display_name: "alice", username: "alice" });

  assert.equal(
    (await send("display-name", { name: "Scunthorpe Snigger" })).status,
    200,
  );
  assert.equal(
    (await send("profile", { name: "Spicy Japes", username: "spicy_japes" }))
      .status,
    200,
  );
  assert.deepEqual(await names(), {
    display_name: "Spicy Japes",
    username: "spicy_japes",
  });
});

test("signup refuses a blocked word in the display name or username without using the invitation", async () => {
  const { token } = await createInvitation(null);
  const pat = await pending("pat", token);
  const send = sender(await cookieFor(pat));
  const uses = async () =>
    (await db.query("SELECT uses FROM invitation")).rows[0].uses;

  assert.deepEqual(await send("setup", { name: "N1gg3r", username: "pat" }), {
    status: 400,
    body: refusal("Display name"),
  });
  assert.deepEqual(
    await send("setup", { name: "Pat", username: "pat_blowjob" }),
    { status: 400, body: refusal("Username") },
  );
  assert.equal(await count("profile", "user_id", pat), 0);
  assert.equal(await uses(), 0);

  assert.equal(
    (await send("setup", { name: "Snigger Spice", username: "scunthorpe" }))
      .status,
    200,
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT display_name,username FROM profile WHERE user_id=$1",
        [pat],
      )
    ).rows,
    [{ display_name: "Snigger Spice", username: "scunthorpe" }],
  );
  assert.equal(await uses(), 1);
});
