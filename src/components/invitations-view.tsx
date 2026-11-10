"use client";
import { Link } from "./pending-navigation";
import { useId, useRef, useState } from "react";
import type { ActionInput, WriteAction } from "../server/actions";
import type { ScreenData } from "../server/screens";
import type { Person } from "../shared";
import { memberPath } from "../member-routes";
import { dateLabel, useInteractive } from "./client";
import { InvitationLink } from "./invitation-link";
import { useActionError } from "./action-error";
import { ActionButton } from "./action-button";
import { ConfirmAction } from "./confirmation";
import { around, useRemovalFocus, type RemovalFocus } from "./removal-focus";

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
  mutate: <Name extends WriteAction>(
    action: Name,
    body: ActionInput<Name>,
  ) => Promise<unknown>;
}) {
  const interactive = useInteractive();
  const [inviteLimit, setInviteLimit] = useState(1);
  const failure = useActionError();
  const removal = useRemovalFocus();
  // A failed read hides the page but keeps the chosen limit, and the cards
  // keep the last snapshot, so an open Revoke confirmation stays, alone,
  // until the next read.
  const [last, setLast] = useState(data);
  if (data && data !== last) setLast(data);
  if (!last) return null;
  return (
    <>
      {data && (
        <>
          <div className="page-heading">
            <h1 className="page-title">Invite friends</h1>
            <p>
              Invite someone to Screenr. Your link works for 30 days. When
              someone completes signup through it, you automatically become
              friends.
            </p>
          </div>
          <form
            className="invite-form"
            onSubmit={(e) => {
              e.preventDefault();
              void failure.run(() => mutate("invite", { limit: inviteLimit }));
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
            >
              Create invitation
            </ActionButton>
          </form>
          {failure.alert}
        </>
      )}
      <div className="invite-list">
        {data && !data.invitations.length && (
          <p className="muted" id="invitations-empty" tabIndex={-1}>
            No active invitations.
          </p>
        )}
        {last.invitations.map((invite) => (
          <InvitationCard
            key={invite.id}
            invite={invite}
            disabled={!interactive}
            busy={busy}
            available={!!data}
            revoke={() => mutate("revoke-invite", { id: invite.id })}
            removal={removal}
          />
        ))}
      </div>
    </>
  );
}

// While the page is not `available`, the card shows only an open Revoke
// confirmation, whose action waits for the next read.
function InvitationCard({
  invite,
  disabled,
  busy,
  available,
  revoke,
  removal,
}: {
  invite: Invitation;
  disabled: boolean;
  busy: boolean;
  available: boolean;
  revoke: () => Promise<unknown>;
  removal: RemovalFocus;
}) {
  const interactive = useInteractive();
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  const id = useId();
  if (!available && !confirming) return null;
  // The signups and expiry name the card. After Revoke, focus moves to the
  // next invitation, the previous one, then the empty list's message.
  return (
    <article
      ref={card}
      className="invite-card"
      aria-labelledby={available ? `${id}-uses ${id}-expires` : undefined}
      tabIndex={-1}
    >
      {available && (
        <div className="section-heading">
          <strong id={`${id}-uses`}>
            {invite.uses} of {invite.max_uses} signups
          </strong>
          <button
            className="text-button"
            ref={trigger}
            disabled={disabled}
            onClick={() => setConfirming(true)}
          >
            Revoke
          </button>
        </div>
      )}
      {confirming && (
        <ConfirmAction
          message="Revoke this invitation? Its link will stop working."
          action="Revoke"
          busy={busy}
          unavailable={!available}
          run={() => {
            removal.start(trigger.current, [
              ...around(
                card.current,
                card.current?.parentElement,
                ".invite-card",
              ),
              "invitations-empty",
            ]);
            return revoke();
          }}
          onDone={() => {
            setConfirming(false);
            removal.done();
          }}
          onCancel={() => {
            setConfirming(false);
            trigger.current?.focus();
          }}
        />
      )}
      {available && (
        <>
          <p className="small muted" id={`${id}-expires`}>
            Expires {dateLabel(invite.expires_at, interactive)}
          </p>
          <InvitationLink key={invite.url} url={invite.url} />
          <p>
            {invite.joined.map((p: Person) => (
              <Link
                className="joined-person"
                key={p.username}
                href={memberPath({ kind: "profile", username: p.username })}
                prefetch={false}
              >
                {p.display_name} (@{p.username})
              </Link>
            ))}
          </p>
        </>
      )}
    </article>
  );
}
