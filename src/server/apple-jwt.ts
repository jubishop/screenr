import { createPrivateKey, sign, type KeyObject } from "node:crypto";

// Apple's token and revoke endpoints, APNs, and the App Store Connect API
// accept ES256 JWTs signed with a .p8 key from the developer account. Callers
// supply the claims each service expects.

// A .p8 key from its PEM file text, or from the single line that app.env
// stores: the base64 PKCS#8 DER body without the PEM header and footer.
export function applePrivateKey(value: string): KeyObject {
  const key = value.includes("-----BEGIN")
    ? createPrivateKey(value)
    : createPrivateKey({
        key: Buffer.from(value, "base64"),
        format: "der",
        type: "pkcs8",
      });
  if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("An Apple key must be a P-256 private key.");
  return key;
}

const segment = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

// The header names the key, plus any fields a service adds, such as
// App Store Connect's `typ`.
export function signAppleJWT(
  key: KeyObject,
  keyId: string,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
) {
  const input = `${segment({ alg: "ES256", kid: keyId, ...header })}.${segment(claims)}`;
  // JWS takes the raw r||s signature, not the DER encoding Node defaults to.
  const signature = sign("sha256", Buffer.from(input), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}
