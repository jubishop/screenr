import { tokenFromCookie } from "./auth";
import { ensureTitle } from "./catalog";
import { addComment, createTitleComment, removeComment } from "./comments";
import {
  completeSignup,
  createInvitation,
  revokeInvitation,
} from "./invitations";
import {
  notifications,
  readAllNotifications,
  readNotification,
  respondToFriendRequest,
  saveActivityEmail,
} from "./notifications";
import { updateDisplayName, updateProfile } from "./profiles";
import { setReaction } from "./reactions";
import { changeRelationship } from "./relationships";
import { loadScreen } from "./screens";
import { saveServices } from "./streaming-services";
import {
  setFinishedDate,
  updateTitleActivity,
  updateWatchStatus,
} from "./title-actions";
import { findTitles } from "./title-viewing";
import type { Person } from "../shared";

// The actions served at /api/screenr/[action]. Each one is declared once,
// with its method, how it reads its input, and what it does. The route
// applies the shared rules: request origin, session, profile, usage
// telemetry, body limits, and error responses.

type Query = URLSearchParams;
type Body = Record<string, unknown>;
type SignedIn = { userId: string; headers: Headers };
type Member = SignedIn & { user: Person };

type Definition<Source, Input, Context> = {
  // Reads this action's fields from the query or JSON body. The services
  // validate each value and own the error messages.
  input: (source: Source) => Input;
  // Its result is the JSON response; actions without one respond
  // `{ ok: true }`.
  run: (input: Input, context: Context) => Promise<unknown>;
};

export type Action =
  | {
      method: "GET";
      profile: true;
      usage: boolean;
      respond: (query: Query, context: Member) => Promise<unknown>;
    }
  | {
      method: "POST";
      profile: true;
      usage: true;
      respond: (body: Body, context: Member) => Promise<unknown>;
    }
  | {
      method: "POST";
      profile: false;
      usage: false;
      respond: (body: Body, context: SignedIn) => Promise<unknown>;
    };

// Member reads count toward usage telemetry only when `usage` is set. Screen
// and notification reads, which clients repeat in the background, do not.
function read<Input>({
  input,
  run,
  usage = false,
}: Definition<Query, Input, Member> & { usage?: boolean }): Action {
  return {
    method: "GET",
    profile: true,
    usage,
    respond: (query, context) => run(input(query), context),
  };
}
// Every member write counts toward usage telemetry, even when rejected.
function write<Input>({ input, run }: Definition<Body, Input, Member>): Action {
  return {
    method: "POST",
    profile: true,
    usage: true,
    respond: (body, context) => run(input(body), context),
  };
}
// Runs before the signed-in person has a profile, and records no usage.
function signup<Input>({
  input,
  run,
}: Definition<Body, Input, SignedIn>): Action {
  return {
    method: "POST",
    profile: false,
    usage: false,
    respond: (body, context) => run(input(body), context),
  };
}

// IDs arrive as JSON strings. Any other value becomes text that matches no
// record, so the service reports it as not found.
const id = (value: unknown) => String(value);

const actions: Record<string, Action> = {
  setup: signup({
    input: ({ name, username }) => ({ name, username }),
    run: ({ name, username }, { userId, headers }) =>
      completeSignup(userId, name, username, tokenFromCookie(headers)),
  }),
  screen: read({
    input: (query) => query.get("path") ?? "/",
    run: async (path, { userId, user }) => ({
      ...(await loadScreen(userId, path)),
      user,
    }),
  }),
  search: read({
    usage: true,
    input: (query) => query.get("q") ?? "",
    run: (text) => findTitles(text),
  }),
  notifications: read({
    input: (query) => ({
      before: query.get("before"),
      unread: query.get("unread") === "true",
      through: query.get("through"),
    }),
    run: ({ before, unread, through }, { userId }) =>
      notifications(userId, before, unread, through),
  }),
  "read-notification": write({
    input: (body) => body.id,
    run: (notification, { userId }) => readNotification(userId, notification),
  }),
  "read-notifications": write({
    input: ({ through }) => through,
    run: (through, { userId }) => readAllNotifications(userId, through),
  }),
  "respond-friend-request": write({
    input: (body) => ({ notification: body.id, action: body.action }),
    run: ({ notification, action }, { userId }) =>
      respondToFriendRequest(userId, notification, action),
  }),
  "activity-email": write({
    input: ({ enabled }) => enabled,
    run: (enabled, { userId }) => saveActivityEmail(userId, enabled),
  }),
  "streaming-services": write({
    input: ({ serviceIds }) => serviceIds,
    run: (serviceIds, { userId }) => saveServices(userId, serviceIds),
  }),
  "display-name": write({
    input: ({ name }) => name,
    run: (name, { userId }) => updateDisplayName(userId, name),
  }),
  profile: write({
    input: ({ name, username }) => ({ name, username }),
    run: ({ name, username }, { userId }) =>
      updateProfile(userId, name, username),
  }),
  invite: write({
    input: ({ limit }) => limit ?? 1,
    run: (limit, { userId }) => createInvitation(userId, limit),
  }),
  "revoke-invite": write({
    input: (body) => id(body.id),
    run: (invitation, { userId }) => revokeInvitation(userId, invitation),
  }),
  relationship: write({
    input: ({ target, action }) => ({ target: id(target), action: id(action) }),
    run: ({ target, action }, { userId }) =>
      changeRelationship(userId, target, action),
  }),
  activity: write({
    input: ({ title, field, value, surface }) => ({
      title: id(title),
      field: id(field),
      value,
      surface,
    }),
    run: async ({ title, field, value, surface }, { userId }) => ({
      id: await updateTitleActivity(
        userId,
        await ensureTitle(title),
        field,
        value,
        surface,
      ),
    }),
  }),
  "watch-status": write({
    input: ({ title, status, finishedOn, surface }) => ({
      title: id(title),
      status,
      finishedOn,
      surface,
    }),
    run: async ({ title, status, finishedOn, surface }, { userId }) => ({
      id: await updateWatchStatus(
        userId,
        await ensureTitle(title),
        status,
        finishedOn,
        surface,
      ),
    }),
  }),
  "finished-date": write({
    input: ({ title, date }) => ({ title: id(title), date }),
    run: async ({ title, date }, { userId }) =>
      setFinishedDate(userId, await ensureTitle(title), date),
  }),
  "title-comment": write({
    input: ({ title, body, spoiler }) => ({ title: id(title), body, spoiler }),
    run: async ({ title, body, spoiler }, { userId }) => ({
      id: await createTitleComment(
        userId,
        await ensureTitle(title),
        body,
        spoiler,
      ),
    }),
  }),
  comment: write({
    input: ({ conversation, body, spoiler, replyTo }) => ({
      conversation: id(conversation),
      body,
      spoiler,
      replyTo,
    }),
    run: async ({ conversation, body, spoiler, replyTo }, { userId }) => ({
      id: await addComment(userId, conversation, body, spoiler, replyTo),
    }),
  }),
  "remove-comment": write({
    input: (body) => id(body.id),
    run: (comment, { userId }) => removeComment(userId, comment),
  }),
  reaction: write({
    input: ({ item, reply, kind }) => ({ item: id(item), reply, kind }),
    run: ({ item, reply, kind }, { userId }) =>
      setReaction(userId, item, reply, kind),
  }),
};

export function findAction(name: string, method: string) {
  const action = Object.hasOwn(actions, name) ? actions[name] : undefined;
  return action?.method === method ? action : undefined;
}
