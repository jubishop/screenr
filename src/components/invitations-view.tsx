"use client";
import Link from "next/link";
import { useState } from "react";
import type { ScreenData } from "../server/screens";
import type { Person } from "../shared";
import { dateLabel, useInteractive } from "./client";
import { InvitationLink } from "./invitation-link";
import { useActionError } from "./action-error";
import { ActionButton } from "./action-button";

type Invitation = Extract<
  ScreenData,
  { kind: "invites" }
>["invitations"][number];

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
  const failure = useActionError();
  // Keep the chosen limit through failed reads without retaining invitation data.
  if (!data) return null;
  return (
    <>
      <div className="page-heading">
        <h1 className="page-title">Invite friends</h1>
        <p>
          Invite someone to Screenr. Your link works for 30 days. When someone
          completes signup through it, you automatically become friends.
        </p>
      </div>
      <form
        className="invite-form"
        onSubmit={(e) => {
          e.preventDefault();
          void failure.run("create", () =>
            mutate("invite", { limit: inviteLimit }),
          );
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
        <ActionButton
          className="primary"
          disabled={!interactive}
          unavailable={busy}
          aria-describedby={failure.describedBy("create")}
        >
          Create invitation
        </ActionButton>
      </form>
      {failure.alert}
      <div className="invite-list">
        {!data.invitations.length && (
          <p className="muted">No active invitations.</p>
        )}
        {data.invitations.map((invite) => (
          <InvitationCard
            key={invite.id}
            invite={invite}
            disabled={!interactive}
            busy={busy}
            revoke={() => mutate("revoke-invite", { id: invite.id })}
          />
        ))}
      </div>
    </>
  );
}

function InvitationCard({
  invite,
  disabled,
  busy,
  revoke,
}: {
  invite: Invitation;
  disabled: boolean;
  busy: boolean;
  revoke: () => Promise<unknown>;
}) {
  const interactive = useInteractive();
  const failure = useActionError();
  return (
    <article className="invite-card">
      <div className="section-heading">
        <strong>
          {invite.uses} of {invite.max_uses} signups
        </strong>
        <ActionButton
          className="text-button"
          disabled={disabled}
          unavailable={busy}
          aria-describedby={failure.describedBy("revoke")}
          onClick={() => void failure.run("revoke", revoke)}
        >
          Revoke
        </ActionButton>
      </div>
      {failure.alert}
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
  );
}
