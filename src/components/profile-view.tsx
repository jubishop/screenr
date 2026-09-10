"use client";
import Link from "next/link";
import type { ScreenData } from "../server/screens";
import type { Person } from "../shared";
import { useInteractive } from "./client";
import { DisplayNameEditor } from "./display-name-editor";
export function ProfileView({
  data,
  user,
  ownProfile,
  busy,
  relationship,
  saveDisplayName,
}: {
  data: Extract<ScreenData, { kind: "profile" }> | null;
  user: Person;
  ownProfile: boolean;
  busy: boolean;
  relationship: (target: string, action: string) => Promise<void>;
  saveDisplayName: (name: string) => Promise<void>;
}) {
  const interactive = useInteractive();
  return (
    <>
      {ownProfile && (
        <div className="page-heading">
          <p className="eyebrow">@{user.username}</p>
          <DisplayNameEditor name={user.display_name} save={saveDisplayName} />
        </div>
      )}
      {data?.kind === "profile" && !ownProfile && (
        <>
          <div className="page-heading">
            <p className="eyebrow">@{data.profile.username}</p>
            <h1>{data.profile.display_name}</h1>
            {data.profile.user_id !== user.user_id && (
              <div className="inline-actions">
                {data.profile.accepted_at && (
                  <Link
                    className="primary button"
                    href={`/watch-together?with=${encodeURIComponent(data.profile.username)}`}
                    prefetch={false}
                  >
                    Watch together
                  </Link>
                )}
                {data.profile.accepted_at ? (
                  <button
                    className="secondary"
                    disabled={busy || !interactive}
                    onClick={() =>
                      void relationship(data.profile.user_id, "remove")
                    }
                  >
                    Unfriend
                  </button>
                ) : data.profile.requested_by === user.user_id ? (
                  <button
                    className="secondary"
                    disabled={busy || !interactive}
                    onClick={() =>
                      void relationship(data.profile.user_id, "remove")
                    }
                  >
                    Cancel friend request
                  </button>
                ) : data.profile.requested_by ? (
                  <button
                    className="primary"
                    disabled={busy || !interactive}
                    onClick={() =>
                      void relationship(data.profile.user_id, "accept")
                    }
                  >
                    Accept friend request
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={busy || !interactive}
                    onClick={() =>
                      void relationship(data.profile.user_id, "request")
                    }
                  >
                    Send friend request
                  </button>
                )}
                <button
                  className="text-button muted"
                  disabled={busy || !interactive}
                  onClick={() =>
                    void relationship(data.profile.user_id, "block")
                  }
                >
                  Block
                </button>
              </div>
            )}
          </div>
        </>
      )}
      {data?.kind === "profile" && (
        <>
          <details className="profile-friends">
            <summary>Friends ({data.profile.friends.length})</summary>
            <section aria-label="Friends">
              {data.profile.friends.map((person) => (
                <div className="person-row" key={person.user_id}>
                  <Link href={`/people/${person.username}`} prefetch={false}>
                    <strong>{person.display_name}</strong>
                    <span className="muted"> @{person.username}</span>
                  </Link>
                </div>
              ))}
              {!data.profile.friends.length && (
                <p className="empty">No friends to show yet.</p>
              )}
            </section>
          </details>
          {!data.profile.can_read && (
            <p className="empty">
              You’ll see their activity after you become friends.
            </p>
          )}
        </>
      )}
    </>
  );
}
