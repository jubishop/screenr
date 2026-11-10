import { deleteAccount } from "./account-deletion";
import { invitationToken } from "./auth";
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
  setupDetails,
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
import { reportContent } from "./reports";
import { removeReview, saveReview } from "./reviews";
import { loadScreen, screenResponse } from "./screens";
import { screenKey } from "./screen-versions";
import { resolveSharedTitle } from "./shared-links";
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

// Each action declares the fields it reads from its query or JSON body by
// name. A name ending in `?` is one that a request may leave out; the web's
// calls name every other one, even when it has no value.
type FieldName<Field extends string> = Field extends `${infer Name}?`
  ? Name
  : Field;
const fieldName = (field: string) => field.replace(/\?$/, "");
// What `input` receives: the declared fields alone, by name, each null when a
// query leaves it out.
type Fields<Field extends string, Value> = {
  [Name in FieldName<Field>]: Value;
};

type Definition<Field extends string, Value, Input, Context, Output> = {
  // The fields this action reads, which ActionInput gives clients.
  fields: readonly Field[];
  // Reads this action's input from its fields. The services validate each
  // value and own the error messages.
  input: (fields: Fields<Field, Value>) => Input;
  // Its result is the JSON response; actions without one respond
  // `{ ok: true }`.
  run: (input: Input, context: Context) => Promise<Output>;
};
// Reads an action's input from its declared fields alone, each taken from the
// query or body by `value`.
function parser<Source, Field extends string, Value, Input>(
  {
    fields,
    input,
  }: Pick<Definition<Field, Value, Input, never, never>, "fields" | "input">,
  value: (source: Source, name: string) => Value,
) {
  const names = fields.map(fieldName);
  return (source: Source) =>
    input(
      Object.fromEntries(
        names.map((name) => [name, value(source, name)]),
      ) as Fields<Field, Value>,
    );
}
// A read's fields and response, from its query.
function reads<Field extends string, Input, Context, Output>(
  definition: Definition<Field, string | null, Input, Context, Output>,
) {
  const parse = parser(definition, (query: Query, name) => query.get(name));
  return {
    fields: definition.fields,
    parse,
    respond: (query: Query, context: Context) =>
      definition.run(parse(query), context),
  };
}
// A write's fields and response, from its JSON body.
function writes<Field extends string, Input, Context, Output>(
  definition: Definition<Field, unknown, Input, Context, Output>,
) {
  const parse = parser(definition, (body: Body, name) => body[name]);
  return {
    fields: definition.fields,
    respond: (body: Body, context: Context) =>
      definition.run(parse(body), context),
  };
}

// Each kind of action keeps its fields, which ActionInput gives clients, and
// its result's type, which ActionResult gives them.
type MemberRead<Field extends string, Output> = {
  method: "GET";
  profile: true;
  usage: boolean;
  // Records the day when the request carries `Screenr-Visit: 1`.
  visits: boolean;
  fields: readonly Field[];
  // The key that this read's unchanged versions are remembered under, for a
  // read that changes only with the database (screen-versions.ts).
  remembers?: (query: Query, userId: string) => string | undefined;
  respond: (query: Query, context: Member) => Promise<Output>;
};
type MemberWrite<Field extends string, Output> = {
  method: "POST";
  profile: true;
  usage: true;
  fields: readonly Field[];
  respond: (body: Body, context: Member) => Promise<Output>;
};
type SignupRead<Field extends string, Output> = {
  method: "GET";
  profile: false;
  usage: false;
  fields: readonly Field[];
  respond: (query: Query, context: SignedIn) => Promise<Output>;
};
type SignupWrite<Field extends string, Output> = {
  method: "POST";
  profile: false;
  // Records the day only once the person has a profile.
  usage: boolean;
  fields: readonly Field[];
  // Reads the raw request body, up to this many bytes, as `upload`.
  upload?: number;
  respond: (body: Body, context: SignedIn) => Promise<Output>;
};
// A write whose request body is a file, which clients send as a Blob.
type Upload<Output> = SignupWrite<never, Output> & { upload: number };
export type Action<Output = unknown> =
  | MemberRead<string, Output>
  | MemberWrite<string, Output>
  | SignupRead<string, Output>
  | SignupWrite<string, Output>;

// Member reads count toward usage telemetry only when `usage` is set. Screen
// and notification reads, which clients repeat in the background, do not,
// except a read with `visits` set that the client flags as a visit.
function read<const Field extends string, Input, Output>({
  usage = false,
  visits = false,
  remembers,
  ...definition
}: Definition<Field, string | null, Input, Member, Output> & {
  usage?: boolean;
  visits?: boolean;
  remembers?: (input: Input, userId: string) => string | undefined;
}): MemberRead<Field, Output> {
  const { parse, ...action } = reads(definition);
  return {
    method: "GET",
    profile: true,
    usage,
    visits,
    remembers:
      remembers && ((query, userId) => remembers(parse(query), userId)),
    ...action,
  };
}
// Every member write counts toward usage telemetry, even when rejected.
function write<const Field extends string, Input, Output>(
  definition: Definition<Field, unknown, Input, Member, Output>,
): MemberWrite<Field, Output> {
  return { method: "POST", profile: true, usage: true, ...writes(definition) };
}
// Runs before the signed-in person has a profile, and records no usage.
function signup<const Field extends string, Input, Output>(
  definition: Definition<Field, unknown, Input, SignedIn, Output>,
): SignupWrite<Field, Output> {
  return {
    method: "POST",
    profile: false,
    usage: false,
    ...writes(definition),
  };
}

// A read that runs before the signed-in person has a profile, and records no
// usage.
function signupRead<const Field extends string, Input, Output>(
  definition: Definition<Field, string | null, Input, SignedIn, Output>,
): SignupRead<Field, Output> {
  const { fields, respond } = reads(definition);
  return { method: "GET", profile: false, usage: false, fields, respond };
}

// Account deletion works with or without a profile. It records no usage,
// since it erases the person's usage rows with everything else.
function erasure<const Field extends string, Input, Output>(
  definition: Definition<Field, unknown, Input, SignedIn, Output>,
): SignupWrite<Field, Output> {
  return {
    method: "POST",
    profile: false,
    usage: false,
    ...writes(definition),
  };
}

// Photo changes work during setup, before the profile exists, and later on
// Account. They count toward usage telemetry once the profile exists.
function photo<const Field extends string, Input, Output>(
  definition: Definition<Field, unknown, Input, SignedIn, Output>,
): SignupWrite<Field, Output> {
  return { method: "POST", profile: false, usage: true, ...writes(definition) };
}
// A photo change whose request body is the image itself, at most `upload`
// bytes.
function photoUpload<Output>({
  upload,
  run,
}: {
  upload: number;
  run: (image: unknown, context: SignedIn) => Promise<Output>;
}): Upload<Output> {
  return {
    method: "POST",
    profile: false,
    usage: true,
    fields: [],
    upload,
    respond: (body, context) => run(body.upload, context),
  };
}

// IDs arrive as JSON strings. Any other value becomes text that matches no
// record, so the service reports it as not found.
const id = (value: unknown) => String(value);

const actions = {
  setup: signup({
    fields: ["name", "username"],
    input: ({ name, username }) => ({ name, username }),
    run: ({ name, username }, { userId, headers }) =>
      completeSignup(userId, name, username, invitationToken(headers)),
  }),
  // What the iPhone app's setup starts from, as the web's setup page reads
  // it: the account's name, its photo, and whether Google can supply one.
  "setup-details": signupRead({
    fields: [],
    input: () => undefined,
    run: (_, { userId }) => setupDetails(userId),
  }),
  // Deletes the signed-in person's account. The session must come from a
  // sign-in in the last ten minutes.
  "delete-account": erasure({
    fields: [],
    input: () => undefined,
    run: (_, { userId, sessionId }) => deleteAccount(userId, sessionId),
  }),
  // The iPhone app flags its first screen read after launch, and after each
  // return to the foreground, as a visit.
  screen: read({
    visits: true,
    fields: ["path?"],
    input: ({ path }) => path ?? "/",
    run: async (path, { userId, user }) =>
      screenResponse(await loadScreen(userId, path), user),
    remembers: (path, userId) => screenKey(userId, path),
  }),
  search: read({
    usage: true,
    fields: ["q?"],
    input: ({ q }) => q ?? "",
    run: (text, { userId }) => findTitles(text, userId),
  }),
  // The iPhone share extension's link and text: the title it names, or the
  // text to search for one.
  "resolve-title": read({
    fields: ["url?", "text?"],
    input: ({ url, text }) => ({ url: url ?? "", text: text ?? "" }),
    run: ({ url, text }) => resolveSharedTitle(url, text),
  }),
  // The TV discussion composer's Season and Episode pickers.
  seasons: read({
    fields: ["title"],
    input: ({ title }) => title ?? "",
    run: async (title) => ({ seasons: await titleSeasons(title) }),
  }),
  episodes: read({
    fields: ["title", "season"],
    input: ({ title, season }) => ({
      title: title ?? "",
      season: Number(season),
    }),
    run: async ({ title, season }) => ({
      episodes: await seasonEpisodes(title, season),
    }),
  }),
  notifications: read({
    fields: ["before?", "unread?", "through?"],
    input: ({ before, unread, through }) => ({
      before,
      unread: unread === "true",
      through,
    }),
    run: ({ before, unread, through }, { userId }) =>
      notifications(userId, before, unread, through),
  }),
  // One notification for the iPhone push extension. A notification the
  // viewer cannot see answers `{ visible: false }`; reading marks nothing.
  notification: read({
    fields: ["id"],
    input: (query) => query.id,
    run: (id, { userId }) => notification(userId, id),
  }),
  "read-notification": write({
    fields: ["id"],
    input: (body) => body.id,
    run: (notification, { userId }) => readNotification(userId, notification),
  }),
  "read-notifications": write({
    fields: ["through"],
    input: ({ through }) => through,
    run: (through, { userId }) => readAllNotifications(userId, through),
  }),
  "respond-friend-request": write({
    fields: ["id", "action"],
    input: (body) => ({ notification: body.id, action: body.action }),
    run: ({ notification, action }, { userId }) =>
      respondToFriendRequest(userId, notification, action),
  }),
  "activity-email": write({
    fields: ["enabled"],
    input: ({ enabled }) => enabled,
    run: (enabled, { userId }) => saveActivityEmail(userId, enabled),
  }),
  // The iPhone app's `register` or `remove` of its APNs device token. Only a
  // registration names its environment, topic, and build.
  "push-device": write({
    fields: ["action", "token", "environment?", "topic?", "build?"],
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
    fields: ["friendRequest?", "friendAccepted?", "comment?", "reply?"],
    input: ({ friendRequest, friendAccepted, comment, reply }) => ({
      friendRequest,
      friendAccepted,
      comment,
      reply,
    }),
    run: (fields, { userId }) => savePushSettings(userId, fields),
  }),
  "streaming-services": write({
    fields: ["serviceIds"],
    input: ({ serviceIds }) => serviceIds,
    run: (serviceIds, { userId }) => saveServices(userId, serviceIds),
  }),
  "display-name": write({
    fields: ["name"],
    input: ({ name }) => name,
    run: (name, { userId }) => updateDisplayName(userId, name),
  }),
  profile: write({
    fields: ["name", "username"],
    input: ({ name, username }) => ({ name, username }),
    run: ({ name, username }, { userId }) =>
      updateProfile(userId, name, username),
  }),
  // The browser sends a 512×512 JPEG as the request body.
  photo: photoUpload({
    upload: photoLimit,
    run: (image, { userId }) => uploadPhoto(userId, image),
  }),
  "remove-photo": photo({
    fields: [],
    input: () => undefined,
    run: (_, { userId }) => removePhoto(userId),
  }),
  "google-photo": photo({
    fields: [],
    input: () => undefined,
    run: (_, { userId }) => chooseGooglePhoto(userId),
  }),
  invite: write({
    fields: ["limit?"],
    input: ({ limit }) => limit ?? 1,
    run: (limit, { userId }) => createInvitation(userId, limit),
  }),
  "revoke-invite": write({
    fields: ["id"],
    input: (body) => id(body.id),
    run: (invitation, { userId }) => revokeInvitation(userId, invitation),
  }),
  relationship: write({
    fields: ["target", "action"],
    input: ({ target, action }) => ({ target: id(target), action: id(action) }),
    run: ({ target, action }, { userId }) =>
      changeRelationship(userId, target, action),
  }),
  activity: write({
    fields: ["title", "field", "value", "surface?"],
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
    fields: ["title", "status", "finishedOn?", "surface?"],
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
    fields: ["title", "date"],
    input: ({ title, date }) => ({ title: id(title), date }),
    run: async ({ title, date }, { userId }) =>
      setFinishedDate(userId, await ensureTitle(title), date),
  }),
  // A review needs a rating, text, or both.
  review: write({
    fields: ["title", "rating?", "body?", "spoiler"],
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
    fields: ["title"],
    input: ({ title }) => id(title),
    run: (title, { userId }) => removeReview(userId, title),
  }),
  // `change` is add, remove, up, down, or move. Adding to a full list names
  // the listed title to remove as `replace`; moving names the new `rank`.
  "top-ten": write({
    fields: ["title", "change", "replace?", "rank?"],
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
    fields: ["title", "body", "spoiler", "season?", "episode?"],
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
    fields: ["body", "spoiler"],
    input: ({ body, spoiler }) => ({ body, spoiler }),
    run: async ({ body, spoiler }, { userId }) => ({
      id: await createDiscussionPost(userId, body, spoiler),
    }),
  }),
  comment: write({
    fields: ["conversation", "body", "spoiler", "replyTo?"],
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
    fields: ["id"],
    input: (body) => id(body.id),
    run: (comment, { userId }) => removeComment(userId, comment),
  }),
  reaction: write({
    fields: ["item", "reply?", "kind"],
    input: ({ item, reply, kind }) => ({ item: id(item), reply, kind }),
    run: ({ item, reply, kind }, { userId }) =>
      setReaction(userId, item, reply, kind),
  }),
  // Reports an entry (`item`), one of its replies (`item` and `reply`), or a
  // profile (`person`, a user ID) for the owner's review, with a `reason` and
  // an optional `note`.
  report: write({
    fields: ["item?", "reply?", "person?", "reason", "note?"],
    input: ({ item, reply, person, reason, note }) => ({
      item,
      reply,
      person,
      reason,
      note,
    }),
    run: (fields, { userId }) => reportContent(userId, fields),
  }),
} satisfies Record<string, Action>;

// Each action's name. The iPhone fixture suite needs a case for every one.
export type ActionName = keyof typeof actions;
// The actions that clients read with GET, and the rest, which they send with
// POST.
export type ReadAction = {
  [Name in ActionName]: (typeof actions)[Name]["method"] extends "GET"
    ? Name
    : never;
}[ActionName];
export type WriteAction = Exclude<ActionName, ReadAction>;
// What a client sends to the action `Name`: a file upload's Blob, a read's
// query, or a write's JSON body. A query or body may name only the action's
// fields and must name each one without a `?`. Values stay loose: the services
// validate them.
export type ActionInput<Name extends ActionName> = Name extends unknown
  ? (typeof actions)[Name] extends Upload<unknown>
    ? Blob
    : Sent<
        (typeof actions)[Name]["fields"][number],
        (typeof actions)[Name]["method"] extends "GET" ? string : unknown
      >
  : never;
// An action that reads no fields accepts an empty object. Otherwise its
// required and optional fields form one object type: an intersection with an
// empty one would accept any object, such as URLSearchParams, for an action
// whose fields are all optional.
type Sent<Field extends string, Value> = [Field] extends [never]
  ? Record<string, never>
  : Flat<
      { [Name in Field as Name extends `${string}?` ? never : Name]: Value } & {
        [
          Name in Field as Name extends `${string}?` ? FieldName<Name> : never
        ]?: Value;
      }
    >;
type Flat<Type> = { [Key in keyof Type]: Type[Key] };
// The JSON response of the action `Name`. An action whose result is null or
// undefined responds `{ ok: true }`.
export type ActionResult<Name extends ActionName> = Reply<
  Awaited<ReturnType<(typeof actions)[Name]["respond"]>>
>;
type Reply<Output> =
  | Exclude<Output, void | null | undefined>
  | (undefined extends Output ? { ok: true } : never)
  | (null extends Output ? { ok: true } : never);
// A result typed `any` or `unknown` would let every web reader type-check,
// so the type check fails while an action's result has no type of its own.
type UntypedResult = {
  [Name in ActionName]: unknown extends ActionResult<Name> ? Name : never;
}[ActionName];
type Typed<Untyped extends never> = Untyped;
type EveryResultTyped = Typed<UntypedResult>;

export function findAction(name: string, method: string) {
  const action: Action | undefined = Object.hasOwn(actions, name)
    ? actions[name as ActionName]
    : undefined;
  return action?.method === method ? action : undefined;
}
