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
  // The choice being saved, shown in place of the saved setting until the
  // save and refresh finish.
  const [saving, setSaving] = useState<boolean | null>(null);
  const busy = saving !== null;
  const [error, setError] = useState("");
  return (
    <section className="settings-card" aria-labelledby="activity-email-heading">
      <h2 id="activity-email-heading">Activity emails</h2>
      <p>
        Get an email about friend requests, new friendships, comments, and
        replies. We wait 10 minutes and group notifications you have not read
        yet.
      </p>
      <label className="checkbox">
        {/* While saving, the setting keeps focus but ignores changes. */}
        <input
          type="checkbox"
          checked={saving ?? enabled ?? false}
          disabled={!interactive || enabled === null}
          aria-disabled={busy}
          onClick={(event) => {
            if (busy) event.preventDefault();
          }}
          onChange={async (event) => {
            if (busy) return;
            const selected = event.target.checked;
            setSaving(selected);
            setError("");
            try {
              await api("activity-email", { enabled: selected });
              await refresh();
            } catch (failure) {
              setError((failure as Error).message);
            } finally {
              setSaving(null);
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
