"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { ScreenData } from "../server/screens";
import type { Person } from "../shared";
import { useInteractive } from "./client";
import { DisplayNameEditor } from "./display-name-editor";
import { Avatar } from "./avatar";
import { Icon } from "./icons";
import { Confirmation } from "./confirmation";
import { useActionError } from "./action-error";

type Profile = Extract<ScreenData, { kind: "profile" }>["profile"];
type Guarded = "remove" | "block";

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
  return (
    <>
      {ownProfile && (
        <div className="page-heading profile-heading">
          <Avatar person={user} />
          <div className="profile-identity">
            <DisplayNameEditor name={user.display_name} save={saveDisplayName}>
              <p className="profile-username">@{user.username}</p>
            </DisplayNameEditor>
          </div>
        </div>
      )}
      {data?.kind === "profile" && !ownProfile && (
        <div className="page-heading">
          <div className="profile-heading">
            <Avatar person={data.profile} />
            <div className="profile-identity">
              <h1>{data.profile.display_name}</h1>
              <p className="profile-username">@{data.profile.username}</p>
            </div>
          </div>
          {data.profile.user_id !== user.user_id && (
            <ProfileActions
              profile={data.profile}
              user={user}
              busy={busy}
              relationship={relationship}
            />
          )}
        </div>
      )}
      {data?.kind === "profile" && (
        <>
          <details className="profile-friends">
            <summary>Friends ({data.profile.friends.length})</summary>
            <section aria-label="Friends">
              {data.profile.friends.map((person) => (
                <div className="person-row link-row" key={person.user_id}>
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

// Watch together and friend-request actions stay visible. Unfriend and Block
// sit in More actions, and each needs an in-page confirmation.
function ProfileActions({
  profile,
  user,
  busy,
  relationship,
}: {
  profile: Profile;
  user: Person;
  busy: boolean;
  relationship: (target: string, action: string) => Promise<void>;
}) {
  const interactive = useInteractive();
  const disabled = busy || !interactive;
  const more = useRef<HTMLButtonElement>(null);
  const [choice, setChoice] = useState<Guarded | null>(null);
  // A friendship that ended elsewhere no longer offers Unfriend.
  const confirming =
    choice === "remove" && !profile.accepted_at ? null : choice;
  const name = profile.display_name;
  // The visible actions share one message beneath their row. The open
  // confirmation keeps its own until it closes.
  const failure = useActionError();
  const guarded = useActionError();
  const act = (action: string) => ({
    "aria-describedby": failure.describedBy(action),
    onClick: () =>
      void failure.run(action, () => relationship(profile.user_id, action)),
  });
  // Return focus to More actions once it is enabled again after an action.
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!restoreFocus.current || disabled) return;
    restoreFocus.current = false;
    more.current?.focus();
  });
  function choose(value: Guarded | null) {
    guarded.clear();
    setChoice(value);
  }
  function close() {
    restoreFocus.current = true;
    choose(null);
  }
  async function confirm() {
    if (!confirming) return;
    const action = confirming;
    if (await guarded.run(action, () => relationship(profile.user_id, action)))
      close();
  }
  const blockEffect = profile.accepted_at
    ? "This ends your friendship. "
    : profile.requested_by
      ? "This removes the pending friend request. "
      : "";
  return (
    <>
      <div className="inline-actions profile-actions">
        {profile.accepted_at ? (
          <Link
            className="primary button"
            href={`/watch-together?with=${encodeURIComponent(profile.username)}`}
            prefetch={false}
          >
            Watch together
          </Link>
        ) : profile.requested_by === user.user_id ? (
          <button className="secondary" disabled={disabled} {...act("remove")}>
            Cancel friend request
          </button>
        ) : profile.requested_by ? (
          <button className="primary" disabled={disabled} {...act("accept")}>
            Accept friend request
          </button>
        ) : (
          <button className="primary" disabled={disabled} {...act("request")}>
            Send friend request
          </button>
        )}
        <MoreActions
          label={`More actions for ${name}`}
          buttonRef={more}
          disabled={disabled}
          items={[
            ...(profile.accepted_at
              ? [{ label: "Unfriend", value: "remove" as const }]
              : []),
            { label: "Block", value: "block" as const },
          ]}
          onSelect={choose}
        />
      </div>
      {failure.alert}
      {confirming && (
        <Confirmation
          key={confirming}
          message={
            confirming === "remove"
              ? `Unfriend ${name}? You’ll both lose access to each other’s posts and discussions.`
              : `Block ${name}? ${blockEffect}You won’t see each other’s profiles, posts, or comments, and neither of you can send a friend request until you unblock them.`
          }
          action={confirming === "remove" ? "Unfriend" : "Block"}
          busy={busy}
          onConfirm={() => void confirm()}
          onCancel={close}
          describedBy={guarded.describedBy(confirming)}
        >
          {guarded.alert}
        </Confirmation>
      )}
    </>
  );
}

// A menu button: Enter, Space, or the arrow keys open it and focus an item.
// Arrow keys, Home, and End move between items. Escape returns to the button;
// moving focus elsewhere or pressing outside closes it.
function MoreActions<T extends string>({
  label,
  items,
  disabled,
  buttonRef,
  onSelect,
}: {
  label: string;
  items: { label: string; value: T }[];
  disabled: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onSelect: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const start = useRef(0);
  const container = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const buttonId = useId();
  const menuId = useId();
  const entries = () =>
    Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ??
        [],
    );
  useEffect(() => {
    if (!open) return;
    const list = entries();
    list.at(start.current)?.focus();
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  if (open && disabled) setOpen(false);
  function show(index: number) {
    start.current = index;
    setOpen(true);
  }
  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }
  return (
    <div
      className="more-actions"
      ref={container}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !container.current?.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          close();
        }
      }}
    >
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className="icon-button more-button"
        aria-label={label}
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show(0))}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          show(event.key === "ArrowDown" ? 0 : -1);
        }}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-labelledby={buttonId}
          className="action-menu"
          onKeyDown={(event) => {
            const list = entries();
            const index = list.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const target =
              event.key === "ArrowDown"
                ? (index + 1) % list.length
                : event.key === "ArrowUp"
                  ? (index - 1 + list.length) % list.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? list.length - 1
                      : null;
            if (target === null) return;
            event.preventDefault();
            list[target].focus();
          }}
        >
          {items.map((item) => (
            <button
              key={item.value}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                onSelect(item.value);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
