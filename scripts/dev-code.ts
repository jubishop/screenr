import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
if (process.env.NODE_ENV === "production")
  throw new Error("Development codes are unavailable in production.");
const email = process.argv[2]?.trim().toLowerCase();
if (!email) throw new Error("Usage: npm run dev:code -- you@example.test");
const filename = createHash("sha256").update(email).digest("hex");
const message = JSON.parse(
  await readFile(`.cache/mail/${filename}.json`, "utf8"),
);
console.log(message.otp);
