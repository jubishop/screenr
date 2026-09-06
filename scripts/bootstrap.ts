import { createInvitation } from "../src/server/invitations";
import { db } from "../src/server/db";
const { token } = await createInvitation(null);
console.log(`${process.env.BETTER_AUTH_URL}/join/${token}`);
await db.end();
