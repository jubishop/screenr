"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { ScreenData } from "../server/screens";
import type { Person } from "../shared";
import { useInteractive } from "./client";
import { Avatar } from "./avatar";
import { useActionError } from "./action-error";

type Action = { label: string; run: () => Promise<void>; primary?: boolean };

// One person: avatar, display name, and @username, linking to the profile.
// The username may wrap beneath the name; actions stay on the same line.
// Notes, then a failed action's message, take the lines beneath. Blocked
// people show only the name, since blocking hides the profile.
function PersonRow({
  person,
  note,
  status,
  actions = [],
  disabled = false,
  blocked = false,
}: {
  person: Person;
  note?: ReactNode;
  status?: string;
  actions?: Action[];
  disabled?: boolean;
  blocked?: boolean;
}) {
  const failure = useActionError();
  const name = (
    <>
      <Avatar person={person} />
      <span className="person-name">
        <strong>{person.display_name}</strong>
        {!blocked && <span className="muted"> @{person.username}</span>}
      </span>
    </>
  );
  return (
    <article className={`person-row${actions.length ? "" : " link-row"}`}>
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
          {actions.map(({ label, run, primary }) => (
            <button
              key={label}
              className={primary ? "primary" : "text-button"}
              disabled={disabled}
              aria-describedby={failure.describedBy(label)}
              onClick={() => void failure.run(label, run)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {note}
      {failure.alert}
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
      <h2 id={id}>{heading}</h2>
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
  // Retain the draft while failed reads hide the protected snapshot.
  if (!data) return null;
  const disabled = busy || !interactive;
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
        <h1 className="page-title">Friends</h1>
        <Link className="primary button" href="/invites" prefetch={false}>
          Invite friends
        </Link>
      </div>
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
                { label: "Accept", run: act(person, "accept"), primary: true },
                { label: "Decline", run: act(person, "remove") },
              ]}
              disabled={disabled}
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
              disabled={disabled}
            />
          ))}
        </PeopleSection>
      )}
      <section
        className="people-suggestions people-list"
        aria-labelledby="people-suggestions-heading"
      >
        <h2 id="people-suggestions-heading">People you may know</h2>
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
              },
            ]}
            disabled={disabled}
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
          <h2 id="people-blocked-heading">Blocked people</h2>
          {data.blocked.map((person) => (
            <PersonRow
              key={person.user_id}
              person={person}
              blocked
              actions={[{ label: "Unblock", run: act(person, "unblock") }]}
              disabled={disabled}
            />
          ))}
        </section>
      )}
    </>
  );
}
