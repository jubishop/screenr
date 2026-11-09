import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { currentMember } from "../../../server/session";
import { isOwner, pendingReports } from "../../../server/reports";
import { ReportReview } from "../../../components/report-review";

export const dynamic = "force-dynamic";
// Anyone but the owner gets the member pages' not-found view, so the page
// sets its title only for the owner.
export const metadata: Metadata = { title: null };

// The owner's review page for members' reports
// (docs/data-and-access.md#content-reports). Signed-out visitors go to
// sign-in as for any member path, and members other than the one
// SCREENR_OWNER_EMAIL names get 404.
export default async function Reports() {
  const user = await currentMember("/reports");
  if (!(await isOwner(user.user_id))) notFound();
  const reports = await pendingReports();
  return (
    <main className="auth-page review-page">
      <title>Reports · Screenr</title>
      <Link href="/" className="brand">
        screenr<span>●</span>
      </Link>
      <div className="auth-card">
        <h1>Reports</h1>
        <p className="muted">
          Open reports, newest first. Act on each within 24 hours.
        </p>
        <ReportReview reports={reports} />
      </div>
    </main>
  );
}
