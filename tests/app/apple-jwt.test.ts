import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { applePrivateKey, signAppleJWT } from "../../src/server/apple-jwt";

const decode = (segment: string) =>
  JSON.parse(Buffer.from(segment, "base64url").toString());

// WebCrypto verifies ES256 signatures in JWS's raw r||s form, independently
// of the signing code.
async function verifies(jwt: string, publicKey: webcrypto.CryptoKey) {
  const [header, payload, signature] = jwt.split(".");
  return webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    Buffer.from(signature!, "base64url"),
    Buffer.from(`${header}.${payload}`),
  );
}

test("Apple keys sign ES256 JWTs from app.env's single-line form or a .p8 file", async () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKey = await webcrypto.subtle.importKey(
    "jwk",
    pair.publicKey.export({ format: "jwk" }),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const singleLine = pair.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" });
  const claims = { iss: "TEAM123456", iat: 1_800_000_000, sub: "app" };
  for (const stored of [singleLine, pem.toString()]) {
    const jwt = signAppleJWT(applePrivateKey(stored), "KEY1234567", claims);
    const [header, payload, signature] = jwt.split(".");
    assert.deepEqual(decode(header!), { alg: "ES256", kid: "KEY1234567" });
    assert.deepEqual(decode(payload!), claims);
    assert.equal(Buffer.from(signature!, "base64url").length, 64);
    assert.ok(await verifies(jwt, publicKey));
  }
  // App Store Connect also expects a JWT type in the header.
  const typed = signAppleJWT(
    applePrivateKey(singleLine),
    "KEY1234567",
    claims,
    { typ: "JWT" },
  );
  assert.deepEqual(decode(typed.split(".")[0]!), {
    alg: "ES256",
    kid: "KEY1234567",
    typ: "JWT",
  });
  assert.ok(await verifies(typed, publicKey));
});

test("Apple keys must be P-256 private keys", () => {
  for (const pair of [
    generateKeyPairSync("ec", { namedCurve: "P-384" }),
    generateKeyPairSync("rsa", { modulusLength: 2048 }),
  ])
    assert.throws(
      () =>
        applePrivateKey(
          pair.privateKey
            .export({ format: "der", type: "pkcs8" })
            .toString("base64"),
        ),
      { message: "An Apple key must be a P-256 private key." },
    );
  assert.throws(() => applePrivateKey("bm90IGEga2V5"));
});
