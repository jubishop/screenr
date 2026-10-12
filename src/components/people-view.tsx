"use client";
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import type { ScreenData } from "../server/screens";
import type { Person } from "../shared";
import { useInteractive } from "./client";
import { Avatar } from "./avatar";
import { useActionError } from "./action-error";
import { ActionButton } from "./action-button";
import { ConfirmAction } from "./confirmation";
import { PageNotice } from "./page-notice";
import { around, useRemovalFocus, type RemovalFocus } from "./removal-focus";

// A destructive action names its `confirm` question and waits for the
// in-page confirmation. An action that moves the person to another section
// `follows` them there with focus.
type Action = {
  label: string;
  run: () => Promise<void>;
  primary?: boolean;
  confirm?: string;
  follows?: boolean;
};

// One person: avatar, display name, and @username, linking to the profile.
// The username may wrap beneath the name; actions stay on the same line.
// Notes, a failed action's message, then an open confirmation take the
// lines beneath. Blocked people show only the name, since blocking hides the
// profile. Pending actions keep focus but ignore presses.
function PersonRow({
  person,
  note,
  status,
  actions = [],
  disabled = false,
  busy = false,
  blocked = false,
  removal,
}: {
  person: Person;
  note?: ReactNode;
  status?: string;
  actions?: Action[];
  disabled?: boolean;
  busy?: boolean;
  blocked?: boolean;
  removal?: RemovalFocus;
}) {
  const failure = useActionError();
  const [confirming, setConfirming] = useState<string | null>(null);
  const open = actions.find(
    (action) => action.confirm && action.label === confirming,
  );
  const trigger = useRef<HTMLButtonElement | null>(null);
  const row = useRef<HTMLElement>(null);
  const id = `person-${person.user_id}`;
  // Each action moves the row or removes it. Focus follows the person to
  // their new row, or moves to the next row in the section, the previous
  // one, then the nearest section heading.
  function leave(control: Element | null, action: Action) {
    const section = row.current?.parentElement;
    removal?.start(control, [
      action.follows ? id : null,
      ...around(row.current, section, ".person-row"),
      ...around(section, section?.parentElement, ".people-list").map((list) =>
        list.querySelector("h2"),
      ),
    ]);
  }
  const name = (
    <>
      <Avatar person={person} />
      <span className="person-name" id={`${id}-name`}>
        <strong>{person.display_name}</strong>
        {!blocked && <span className="muted"> @{person.username}</span>}
      </span>
    </>
  );
  return (
    <article
      ref={row}
      id={id}
      className={`person-row${actions.length ? "" : " link-row"}`}
      aria-labelledby={`${id}-name`}
      tabIndex={-1}
    >
      {blocked ? (
        <span className="person">{name}</span>
      ) : (
        <Link
          className="person"
          href={`/people/${person.username}`}
          prefetch={false}
        >
          {name}
        </Link>
      )}
      {actions.length > 0 && (
        <div className="person-actions">
          {status && <span className="small muted">{status}</span>}
          {actions.map((action) => (
            <ActionButton
              key={action.label}
              className={action.primary ? "primary" : "text-button"}
              disabled={disabled}
              unavailable={busy}
              aria-describedby={failure.describedBy(action.label)}
              onClick={(event) => {
                if (action.confirm) {
                  trigger.current = event.currentTarget;
                  return setConfirming(action.label);
                }
                leave(event.currentTarget, action);
                void failure.run(action.label, action.run).then((done) => {
                  if (done) removal?.done();
                });
              }}
            >
              {action.label}
            </ActionButton>
          ))}
        </div>
      )}
      {note}
      {failure.alert}
      {open?.confirm && (
        <ConfirmAction
          key={open.label}
          message={open.confirm}
          action={open.label}
          busy={busy}
          run={() => {
            leave(trigger.current, open);
            return open.run();
          }}
          onDone={() => {
            setConfirming(null);
            removal?.done();
          }}
          onCancel={() => {
            setConfirming(null);
            trigger.current?.focus();
          }}
        />
      )}
    </article>
  );
}

function PeopleSection({
  id,
  heading,
  children,
}: {
  id: string;
  heading: string;
  children: ReactNode;
}) {
  return (
    <section className="people-list" aria-labelledby={id}>
      <h2 id={id} tabIndex={-1}>
        {heading}
      </h2>
      {children}
    </section>
  );
}

export function PeopleView({
  data,
  user,
  busy,
  relationship,
}: {
  data: Extract<ScreenData, { kind: "people" }> | null;
  user: Person;
  busy: boolean;
  relationship: (target: string, action: string) => Promise<void>;
}) {
  const interactive = useInteractive();
  const [query, setQuery] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const removal = useRemovalFocus();
  // Retain the draft while failed reads hide the protected snapshot.
  if (!data) return null;
  const act = (person: Person, action: string) => () =>
    relationship(person.user_id, action);
  const requests = data.connections.filter(
    (p) => !p.accepted_at && p.requested_by !== user.user_id,
  );
  const friends = data.connections.filter((p) => p.accepted_at);
  const sent = data.connections.filter(
    (p) => !p.accepted_at && p.requested_by === user.user_id,
  );
  return (
    <>
      <div className="page-heading heading-row">
        <h1 className="page-title" ref={heading} tabIndex={-1}>
          Friends
        </h1>
        <Link className="primary button" href="/invites" prefetch={false}>
          Invite friends
        </Link>
      </div>
      {/* Block opens this page with its result. */}
      <PageNotice path="/people" onDismiss={() => heading.current?.focus()} />
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          window.location.assign(
            `/people/${encodeURIComponent(query.trim().toLowerCase())}`,
          );
        }}
      >
        <label className="sr-only" htmlFor="friend-search">
          Exact username
        </label>
        <input
          disabled={!interactive}
          id="friend-search"
          placeholder="Find an exact username"
          value={query}
          required
          pattern="[a-zA-Z0-9_]{3,24}"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="primary">Find</button>
      </form>
      {!data.connections.length && (
        <p className="empty">
          Start with someone you know. Find their username or send an
          invitation.
        </p>
      )}
      {requests.length > 0 && (
        <PeopleSection id="people-requests-heading" heading="Requests">
          {requests.map((person) => (
            <PersonRow
              key={person.user_id}
              person={person}
              actions={[
                {
                  label: "Accept",
                  run: act(person, "accept"),
                  primary: true,
                  follows: true,
                },
                {
                  label: "Decline",
                  run: act(person, "remove"),
                  confirm: `Decline ${person.display_name}’s friend request? The request will be removed.`,
                },
              ]}
              disabled={!interactive}
              busy={busy}
              removal={removal}
            />
          ))}
        </PeopleSection>
      )}
      {friends.length > 0 && (
        <PeopleSection id="people-friends-heading" heading="Friends">
          {friends.map((person) => (
            <PersonRow key={person.user_id} person={person} />
          ))}
        </PeopleSection>
      )}
      {sent.length > 0 && (
        <PeopleSection id="people-sent-heading" heading="Sent requests">
          {sent.map((person) => (
            <PersonRow
              key={person.user_id}
              person={person}
              status="Request sent"
              actions={[{ label: "Cancel", run: act(person, "remove") }]}
              disabled={!interactive}
              busy={busy}
              removal={removal}
            />
          ))}
        </PeopleSection>
      )}
      <section
        className="people-suggestions people-list"
        aria-labelledby="people-suggestions-heading"
      >
        <h2 id="people-suggestions-heading" tabIndex={-1}>
          People you may know
        </h2>
        <p className="muted">Meet people through your mutual friends.</p>
        {data.suggestions.map((person) => (
          <PersonRow
            key={person.user_id}
            person={person}
            note={
              <p className="person-note small muted">
                {person.mutual_friends.length === 1
                  ? "Mutual friend: "
                  : "Mutual friends: "}
                {person.mutual_friends.map((mutual, index) => (
                  <span key={mutual.user_id}>
                    {index > 0 && ", "}
                    <Link href={`/people/${mutual.username}`} prefetch={false}>
                      {mutual.display_name} (@{mutual.username})
                    </Link>
                  </span>
                ))}
              </p>
            }
            actions={[
              {
                label: "Send friend request",
                run: act(person, "request"),
                primary: true,
                follows: true,
              },
            ]}
            disabled={!interactive}
            busy={busy}
            removal={removal}
          />
        ))}
        {!data.suggestions.length && (
          <p className="empty">No friend suggestions yet.</p>
        )}
      </section>
      {data.blocked.length > 0 && (
        <section
          className="people-list"
          aria-labelledby="people-blocked-heading"
        >
          <h2 id="people-blocked-heading" tabIndex={-1}>
            Blocked people
          </h2>
          {data.blocked.map((person) => (
            <PersonRow
              key={person.user_id}
              person={person}
              blocked
              actions={[{ label: "Unblock", run: act(person, "unblock") }]}
              disabled={!interactive}
              busy={busy}
              removal={removal}
            />
          ))}
        </section>
      )}
    </>
  );
}
