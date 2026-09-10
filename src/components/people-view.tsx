"use client";
import Link from "next/link";
import { useState } from "react";
import type { ScreenData } from "../server/screens";
import type { Person } from "../shared";
import { useInteractive } from "./client";
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
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">GOOD COMPANY</p>
        <h1>Your friends.</h1>
        <p>Friendships start with a request and an acceptance.</p>
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
        <button className="primary">Find person</button>
      </form>
      <div className="people-list">
        {data.connections.map((p) => (
          <article className="person-row" key={p.user_id}>
            <Link href={`/people/${p.username}`} prefetch={false}>
              <strong>{p.display_name}</strong>
              <span className="muted"> @{p.username}</span>
            </Link>
            <div className="inline-actions">
              {p.accepted_at ? (
                <>
                  <span className="badge">Friends</span>
                  <button
                    className="text-button"
                    disabled={busy || !interactive}
                    onClick={() => void relationship(p.user_id, "remove")}
                  >
                    Unfriend
                  </button>
                </>
              ) : p.requested_by === user.user_id ? (
                <>
                  <span className="small muted">Request sent</span>
                  <button
                    className="text-button"
                    disabled={busy || !interactive}
                    onClick={() => void relationship(p.user_id, "remove")}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="primary"
                    disabled={busy || !interactive}
                    onClick={() => void relationship(p.user_id, "accept")}
                  >
                    Accept
                  </button>
                  <button
                    className="text-button"
                    disabled={busy || !interactive}
                    onClick={() => void relationship(p.user_id, "remove")}
                  >
                    Decline
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
        {!data.connections.length && (
          <p className="empty">
            Start with someone you know. Find their username or send an
            invitation.
          </p>
        )}
      </div>
      <section
        className="people-suggestions people-list"
        aria-labelledby="people-suggestions-heading"
      >
        <h2 id="people-suggestions-heading">People you may know</h2>
        <p className="muted">Meet people through your mutual friends.</p>
        {data.suggestions.map((person) => (
          <article className="person-row" key={person.user_id}>
            <div>
              <Link href={`/people/${person.username}`} prefetch={false}>
                <strong>{person.display_name}</strong>
                <span className="muted"> @{person.username}</span>
              </Link>
              <p className="small muted">
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
            </div>
            <button
              className="primary"
              disabled={busy || !interactive}
              onClick={() => void relationship(person.user_id, "request")}
            >
              Send friend request
            </button>
          </article>
        ))}
        {!data.suggestions.length && (
          <p className="empty">No friend suggestions yet.</p>
        )}
      </section>
      {data.blocked.length > 0 && (
        <>
          <h2>Blocked people</h2>
          {data.blocked.map((p) => (
            <div className="person-row" key={p.user_id}>
              <span>{p.display_name}</span>
              <button
                className="text-button"
                disabled={busy || !interactive}
                onClick={() => void relationship(p.user_id, "unblock")}
              >
                Unblock
              </button>
            </div>
          ))}
        </>
      )}
    </>
  );
}
