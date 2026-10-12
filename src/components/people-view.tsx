"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { ScreenData } from "../server/screens";
import type { Person } from "../shared";
import { useInteractive } from "./client";
import { Avatar } from "./avatar";

// One person: avatar, display name, and @username, linking to the profile.
// The username may wrap beneath the name; actions stay on the same line.
function PersonRow({
  person,
  note,
  children,
}: {
  person: Person;
  note?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article className={`person-row${children ? "" : " link-row"}`}>
      <Link
        className="person"
        href={`/people/${person.username}`}
        prefetch={false}
      >
        <Avatar person={person} />
        <span className="person-name">
          <strong>{person.display_name}</strong>
          <span className="muted"> @{person.username}</span>
        </span>
      </Link>
      {children && <div className="person-actions">{children}</div>}
      {note}
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
            <PersonRow key={person.user_id} person={person}>
              <button
                className="primary"
                disabled={disabled}
                onClick={() => void relationship(person.user_id, "accept")}
              >
                Accept
              </button>
              <button
                className="text-button"
                disabled={disabled}
                onClick={() => void relationship(person.user_id, "remove")}
              >
                Decline
              </button>
            </PersonRow>
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
            <PersonRow key={person.user_id} person={person}>
              <span className="small muted">Request sent</span>
              <button
                className="text-button"
                disabled={disabled}
                onClick={() => void relationship(person.user_id, "remove")}
              >
                Cancel
              </button>
            </PersonRow>
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
          >
            <button
              className="primary"
              disabled={disabled}
              onClick={() => void relationship(person.user_id, "request")}
            >
              Send friend request
            </button>
          </PersonRow>
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
            <article className="person-row" key={person.user_id}>
              <span className="person">
                <Avatar person={person} />
                <span className="person-name">
                  <strong>{person.display_name}</strong>
                </span>
              </span>
              <div className="person-actions">
                <button
                  className="text-button"
                  disabled={disabled}
                  onClick={() => void relationship(person.user_id, "unblock")}
                >
                  Unblock
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
