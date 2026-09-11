"use client";
import { useState } from "react";
import { api, useInteractive } from "./client";

export function ActivityEmailSetting({
  enabled,
  refresh,
}: {
  enabled: boolean | null;
  refresh: () => Promise<void>;
}) {
  const interactive = useInteractive();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="settings-card" aria-labelledby="activity-email-heading">
      <h2 id="activity-email-heading">Activity emails</h2>
      <p>
        Get an email about new friend requests and replies. We wait 10 minutes
        and group notifications you have not read yet.
      </p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled ?? false}
          disabled={!interactive || busy || enabled === null}
          onChange={async (event) => {
            const selected = event.target.checked;
            setBusy(true);
            setError("");
            try {
              await api("activity-email", { enabled: selected });
              await refresh();
            } catch (failure) {
              setError((failure as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
        Email me about new activity
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
