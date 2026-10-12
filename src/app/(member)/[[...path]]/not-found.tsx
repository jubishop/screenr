import { admittedMember } from "../../../server/session";
import { MissingScreen } from "../../../components/screen";

// The member page calls notFound() for a missing title, person, or page. This
// view keeps the member's navigation around the screen's not-found message.
export default async function NotFound() {
  const user = await admittedMember();
  return user && <MissingScreen user={user} />;
}
