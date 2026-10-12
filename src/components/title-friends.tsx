"use client";
import { Fragment, type ReactElement } from "react";
import type { FriendAction, FriendActivity } from "../shared";

const namedFriends = 3;

// "A", "A and B", "A, B, and C", or "A, B, C, and 2 more". Each name is an
// in-page link to that friend's entry; showEntry scrolls to and focuses it.
function Names({
  people,
  showEntry,
}: {
  people: FriendAction[];
  showEntry: (item: string) => void;
}) {
  const parts: ReactElement[] = people.slice(0, namedFriends).map((person) => (
    <a
      key={person.item}
      href={`#item-${person.item}`}
      onClick={(event) => {
        event.preventDefault();
        showEntry(person.item);
      }}
    >
      {person.display_name}
    </a>
  ));
  const others = people.length - parts.length;
  if (others) parts.push(<Fragment key="others">{others} more</Fragment>);
  return parts.map((part, index) => (
    <Fragment key={part.key}>
      {index === 0
        ? ""
        : parts.length === 2
          ? " and "
          : index === parts.length - 1
            ? ", and "
            : ", "}
      {part}
    </Fragment>
  ));
}

// Below the title header's buttons: which friends recommend or want to watch
// the title, recommenders first. Hidden when no friend has either action.
// Each group wraps as a unit when it fits on one line.
export function TitleFriends({
  friends,
  showEntry,
}: {
  friends: FriendActivity;
  showEntry: (item: string) => void;
}) {
  const { recommended, want_to_watch: wanted } = friends;
  if (!recommended.length && !wanted.length) return null;
  return (
    <p className="friend-activity">
      {recommended.length > 0 && (
        <span>
          Recommended by <Names people={recommended} showEntry={showEntry} />
          {/* The separator ends the first group's line when the groups wrap. */}
          {wanted.length > 0 && "\u00a0·"}
        </span>
      )}
      {recommended.length > 0 && wanted.length > 0 && " "}
      {wanted.length > 0 && (
        <span>
          <Names people={wanted} showEntry={showEntry} />{" "}
          {wanted.length === 1 ? "wants" : "want"} to watch
        </span>
      )}
    </p>
  );
}
