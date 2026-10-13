"use client";
import { Link } from "./pending-navigation";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { ScreenData } from "../server/screens";
import type { Person } from "../shared";
import { useInteractive } from "./client";
import { DisplayNameEditor } from "./display-name-editor";
import { Avatar } from "./avatar";
import { Icon } from "./icons";
import { ConfirmAction } from "./confirmation";
import { useActionError } from "./action-error";
import { ActionButton } from "./action-button";

type Profile = Extract<ScreenData, { kind: "profile" }>["profile"];
type Guarded = "remove" | "block";

export function ProfileView({
  data,
  user,
  ownProfile,
  busy,
  relationship,
  block,
  saveDisplayName,
}: {
  data: Extract<ScreenData, { kind: "profile" }> | null;
  user: Person;
  ownProfile: boolean;
  busy: boolean;
  relationship: (target: string, action: string) => Promise<void>;
  block: (person: Person) => Promise<void>;
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
              block={block}
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
// sit in More actions, and each needs an in-page confirmation. A confirmed
// Block opens the Friends page.
function ProfileActions({
  profile,
  user,
  busy,
  relationship,
  block,
}: {
  profile: Profile;
  user: Person;
  busy: boolean;
  relationship: (target: string, action: string) => Promise<void>;
  block: (person: Person) => Promise<void>;
}) {
  const interactive = useInteractive();
  const row = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [choice, setChoice] = useState<Guarded | null>(null);
  // A friendship that ended elsewhere no longer offers Unfriend.
  const confirming =
    choice === "remove" && !profile.accepted_at ? null : choice;
  const name = profile.display_name;
  // The visible actions share one message beneath their row. The open
  // confirmation keeps its own until it closes.
  const failure = useActionError();
  // Pending actions keep focus. Once a focused action finishes, focus moves
  // to the control that replaced it, such as Watch together after Accept.
  // It returns to More actions when a confirmation closes.
  const restoreFocus = useRef<"row" | "more" | null>(null);
  useEffect(() => {
    if (!restoreFocus.current || busy) return;
    const target = restoreFocus.current;
    restoreFocus.current = null;
    if (target === "more") more.current?.focus();
    else if (document.activeElement === document.body)
      (row.current?.firstElementChild as HTMLElement | null)?.focus();
  });
  const act = (action: string) => ({
    disabled: !interactive,
    unavailable: busy,
    "aria-describedby": failure.describedBy(action),
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      if (event.currentTarget === document.activeElement)
        restoreFocus.current = "row";
      void failure.run(action, () => relationship(profile.user_id, action));
    },
  });
  function close() {
    restoreFocus.current = "more";
    setChoice(null);
  }
  const blockEffect = profile.accepted_at
    ? "This ends your friendship. "
    : profile.requested_by
      ? "This removes the pending friend request. "
      : "";
  return (
    <>
      <div className="inline-actions profile-actions" ref={row}>
        {profile.accepted_at ? (
          <Link
            className="primary button"
            href={`/watch-together?with=${encodeURIComponent(profile.username)}`}
            prefetch={false}
          >
            Watch together
          </Link>
        ) : profile.requested_by === user.user_id ? (
          <ActionButton className="secondary" {...act("remove")}>
            Cancel friend request
          </ActionButton>
        ) : profile.requested_by ? (
          <ActionButton className="primary" {...act("accept")}>
            Accept friend request
          </ActionButton>
        ) : (
          <ActionButton className="primary" {...act("request")}>
            Send friend request
          </ActionButton>
        )}
        <MoreActions
          label={`More actions for ${name}`}
          buttonRef={more}
          disabled={!interactive}
          unavailable={busy}
          items={[
            ...(profile.accepted_at
              ? [{ label: "Unfriend", value: "remove" as const }]
              : []),
            { label: "Block", value: "block" as const },
          ]}
          onSelect={setChoice}
        />
      </div>
      {failure.alert}
      {confirming === "remove" && (
        <ConfirmAction
          key="remove"
          message={`Unfriend ${name}? You’ll both lose access to each other’s posts and discussions.`}
          action="Unfriend"
          busy={busy}
          run={() => relationship(profile.user_id, "remove")}
          onDone={close}
          onCancel={close}
        />
      )}
      {/* Block stays open, busy, until the Friends page replaces it. */}
      {confirming === "block" && (
        <ConfirmAction
          key="block"
          message={`Block ${name}? ${blockEffect}You won’t see each other’s profiles, posts, or comments, and neither of you can send a friend request until you unblock them.`}
          action="Block"
          busy={busy}
          run={() => block(profile)}
          onDone={() => {}}
          onCancel={close}
        />
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
  unavailable,
  buttonRef,
  onSelect,
}: {
  label: string;
  items: { label: string; value: T }[];
  disabled: boolean;
  unavailable: boolean;
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
  if (open && (disabled || unavailable)) setOpen(false);
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
      <ActionButton
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
        unavailable={unavailable}
        onClick={() => (open ? setOpen(false) : show(0))}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (!unavailable) show(event.key === "ArrowDown" ? 0 : -1);
        }}
      >
        <Icon name="more" />
      </ActionButton>
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
