import { initial } from "./initial";
import { Icon } from "./icons";

// The palette lives in style.css as --avatar-0 through --avatar-7.
export const avatarTones = 8;

// A stable user ID picks the color, so renaming keeps a person's color.
export function avatarTone(userId: string) {
  let hash = 0;
  for (let index = 0; index < userId.length; index++)
    hash = (Math.imul(hash, 31) + userId.charCodeAt(index)) >>> 0;
  return hash % avatarTones;
}

// Every place a member appears uses this avatar beside their visible name, so
// it is decorative. A person who is not available gets a neutral placeholder.
// A future profile photo replaces the initial here.
export function Avatar({
  person,
}: {
  person: { user_id: string; display_name: string } | null;
}) {
  if (!person)
    return (
      <span className="avatar avatar-placeholder" aria-hidden="true">
        <Icon name="person" />
      </span>
    );
  return (
    <span
      className="avatar"
      data-tone={avatarTone(person.user_id)}
      aria-hidden="true"
    >
      {initial(person.display_name)}
    </span>
  );
}
