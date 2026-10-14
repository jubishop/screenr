import { tokenFromCookie } from "./auth";
import { ensureTitle, seasonEpisodes, titleSeasons } from "./catalog";
import {
  addComment,
  createDiscussionPost,
  createTitleComment,
  removeComment,
} from "./comments";
import {
  completeSignup,
  createInvitation,
  revokeInvitation,
} from "./invitations";
import {
  notification,
  notifications,
  readAllNotifications,
  readNotification,
  respondToFriendRequest,
  saveActivityEmail,
} from "./notifications";
import {
  chooseGooglePhoto,
  photoLimit,
  removePhoto,
  uploadPhoto,
} from "./photos";
import { updateDisplayName, updateProfile } from "./profiles";
import { changePushDevice, savePushSettings } from "./push";
import { setReaction } from "./reactions";
import { changeRelationship } from "./relationships";
import { removeReview, saveReview } from "./reviews";
import { loadScreen, screenResponse } from "./screens";
import { saveServices } from "./streaming-services";
import {
  setFinishedDate,
  updateTitleActivity,
  updateTopTen,
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
// `sessionId` names the request's Better Auth session row.
type SignedIn = { userId: string; sessionId: string; headers: Headers };
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
      // Records the day only once the person has a profile.
      usage: boolean;
      // Reads the raw request body, up to this many bytes, as `upload`.
      upload?: number;
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

// Photo changes work during setup, before the profile exists, and later on
// Account. They count toward usage telemetry once the profile exists.
function photo<Input>({
  input,
  run,
  upload,
}: Definition<Body, Input, SignedIn> & { upload?: number }): Action {
  return {
    method: "POST",
    profile: false,
    usage: true,
    upload,
    respond: (body, context) => run(input(body), context),
  };
}

// IDs arrive as JSON strings. Any other value becomes text that matches no
// record, so the service reports it as not found.
const id = (value: unknown) => String(value);

const actions = {
  setup: signup({
    input: ({ name, username }) => ({ name, username }),
    run: ({ name, username }, { userId, headers }) =>
      completeSignup(userId, name, username, tokenFromCookie(headers)),
  }),
  screen: read({
    input: (query) => query.get("path") ?? "/",
    run: async (path, { userId, user }) =>
      screenResponse(await loadScreen(userId, path), user),
  }),
  search: read({
    usage: true,
    input: (query) => query.get("q") ?? "",
    run: (text) => findTitles(text),
  }),
  // The TV discussion composer's Season and Episode pickers.
  seasons: read({
    input: (query) => query.get("title") ?? "",
    run: async (title) => ({ seasons: await titleSeasons(title) }),
  }),
  episodes: read({
    input: (query) => ({
      title: query.get("title") ?? "",
      season: Number(query.get("season")),
    }),
    run: async ({ title, season }) => ({
      episodes: await seasonEpisodes(title, season),
    }),
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
  // One notification for the iPhone push extension. A notification the
  // viewer cannot see answers `{ visible: false }`; reading marks nothing.
  notification: read({
    input: (query) => query.get("id"),
    run: (id, { userId }) => notification(userId, id),
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
  // The iPhone app's `register` or `remove` of its APNs device token.
  "push-device": write({
    input: ({ action, token, environment, topic, build }) => ({
      action,
      token,
      environment,
      topic,
      build,
    }),
    run: (fields, { userId, sessionId }) =>
      changePushDevice(userId, sessionId, fields),
  }),
  // Turns push kinds on or off; kinds the body leaves out keep their values.
  "push-settings": write({
    input: ({ friendRequest, friendAccepted, comment, reply }) => ({
      friendRequest,
      friendAccepted,
      comment,
      reply,
    }),
    run: (fields, { userId }) => savePushSettings(userId, fields),
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
  // The browser sends a 512×512 JPEG as the request body.
  photo: photo({
    upload: photoLimit,
    input: ({ upload }) => upload,
    run: (upload, { userId }) => uploadPhoto(userId, upload),
  }),
  "remove-photo": photo({
    input: () => undefined,
    run: (_, { userId }) => removePhoto(userId),
  }),
  "google-photo": photo({
    input: () => undefined,
    run: (_, { userId }) => chooseGooglePhoto(userId),
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
  review: write({
    input: ({ title, rating, body, spoiler }) => ({
      title: id(title),
      rating,
      body,
      spoiler,
    }),
    run: async ({ title, rating, body, spoiler }, { userId }) => ({
      id: await saveReview(
        userId,
        await ensureTitle(title),
        rating,
        body,
        spoiler,
      ),
    }),
  }),
  "remove-review": write({
    input: ({ title }) => id(title),
    run: (title, { userId }) => removeReview(userId, title),
  }),
  // `change` is add, remove, up, down, or move. Adding to a full list names
  // the listed title to remove as `replace`; moving names the new `rank`.
  "top-ten": write({
    input: ({ title, change, replace, rank }) => ({
      title: id(title),
      change,
      replace,
      rank,
    }),
    run: async ({ title, change, replace, rank }, { userId }) =>
      updateTopTen(
        userId,
        change === "add" ? await ensureTitle(title) : title,
        change,
        { replace, rank },
      ),
  }),
  "title-comment": write({
    input: ({ title, body, spoiler, season, episode }) => ({
      title: id(title),
      body,
      spoiler,
      season,
      episode,
    }),
    run: async ({ title, body, spoiler, season, episode }, { userId }) => ({
      id: await createTitleComment(
        userId,
        await ensureTitle(title),
        body,
        spoiler,
        season,
        episode,
      ),
    }),
  }),
  "discussion-post": write({
    input: ({ body, spoiler }) => ({ body, spoiler }),
    run: async ({ body, spoiler }, { userId }) => ({
      id: await createDiscussionPost(userId, body, spoiler),
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
} satisfies Record<string, Action>;

// Each action's name. The iPhone fixture suite needs a case for every one.
export type ActionName = keyof typeof actions;

export function findAction(name: string, method: string) {
  const action: Action | undefined = Object.hasOwn(actions, name)
    ? actions[name as ActionName]
    : undefined;
  return action?.method === method ? action : undefined;
}
