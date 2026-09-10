"use client";
import Link from "next/link";
import { useState } from "react";
import type { ScreenData } from "../server/screens";
import type { Person } from "../shared";
import { dateLabel, useInteractive } from "./client";
import { InvitationLink } from "./invitation-link";
export function InvitationsView({
  data,
  busy,
  mutate,
}: {
  data: Extract<ScreenData, { kind: "invites" }> | null;
  busy: boolean;
  mutate: (action: string, body: unknown) => Promise<unknown>;
}) {
  const interactive = useInteractive();
  const [inviteLimit, setInviteLimit] = useState(1);
  // Keep the chosen limit through failed reads without retaining invitation data.
  if (!data) return null;
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">MAKE ROOM FOR FRIENDS</p>
        <h1>Good things are shared.</h1>
        <p>
          Invite someone to Screenr. Your link works for 30 days. When someone
          completes signup through it, you automatically become friends.
        </p>
      </div>
      <form
        className="invite-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await mutate("invite", { limit: inviteLimit });
        }}
      >
        <label>
          Maximum signups
          <select
            disabled={!interactive}
            value={inviteLimit}
            onChange={(e) => setInviteLimit(Number(e.target.value))}
          >
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={busy || !interactive}>
          Create invitation
        </button>
      </form>
      <div className="invite-list">
        {!data.invitations.length && (
          <p className="muted">No active invitations.</p>
        )}
        {data.invitations.map((invite) => (
          <article className="invite-card" key={invite.id}>
            <div className="section-heading">
              <strong>
                {invite.uses} of {invite.max_uses} signups
              </strong>
              <button
                className="text-button"
                disabled={busy || !interactive}
                onClick={() => void mutate("revoke-invite", { id: invite.id })}
              >
                Revoke
              </button>
            </div>
            <p className="small muted">
              Expires {dateLabel(invite.expires_at, interactive)}
            </p>
            <InvitationLink key={invite.url} url={invite.url} />
            <p>
              {invite.joined.map((p: Person) => (
                <Link
                  className="joined-person"
                  key={p.username}
                  href={`/people/${p.username}`}
                  prefetch={false}
                >
                  {p.display_name} (@{p.username})
                </Link>
              ))}
            </p>
          </article>
        ))}
      </div>
    </>
  );
}
