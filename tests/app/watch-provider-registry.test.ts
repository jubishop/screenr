import { test } from "node:test";
import assert from "node:assert/strict";
import registry from "../../src/server/watch-provider-registry.json";
import snapshot from "../fixtures/watch-provider-catalogs-us.json";

test("the reviewed registry covers the full US movie/TV snapshot with exactly one service per provider", () => {
  const known = new Set([...snapshot.movie, ...snapshot.tv]);
  assert.equal(snapshot.region, "US");
  assert.equal(snapshot.language, "en-US");
  assert.ok(Number.isFinite(Date.parse(snapshot.fetched_at)));
  assert.equal(new Set(snapshot.movie).size, snapshot.movie.length);
  assert.equal(new Set(snapshot.tv).size, snapshot.tv.length);
  assert.deepEqual(
    new Set(snapshot.providers.map((p) => p.provider_id)),
    known,
  );
  assert.equal(snapshot.providers.length, known.size);
  const members = registry.flatMap((service) => service.members);
  assert.equal(
    new Set(members.map((member) => member.id)).size,
    members.length,
  );
  assert.deepEqual(new Set(members.map((member) => member.id)), known);
  assert.equal(
    new Set(registry.map((service) => service.key)).size,
    registry.length,
  );
  for (const service of registry) {
    assert.match(service.key, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(service.name.trim());
    assert.ok(service.members.length);
    if (service.logo_path)
      assert.match(service.logo_path, /^\/[a-zA-Z0-9._-]+$/);
    for (const member of service.members) {
      assert.ok(Number.isSafeInteger(member.id) && member.id > 0);
      assert.ok(
        member.via === null ||
          ["Amazon", "Apple TV", "Roku"].includes(member.via),
      );
    }
  }
});
