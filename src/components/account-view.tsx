"use client";
import Link from "next/link";
import { useState } from "react";
import type { ScreenData } from "../server/screens";
import type { Person } from "../shared";
import { authClient, useInteractive } from "./client";
import { AccountProfileEditor } from "./account-profile-editor";
import { StreamingServicesEditor } from "./streaming-services-editor";
import { ActivityEmailSetting } from "./activity-email-setting";
export function AccountView({
  data,
  user,
  busy,
  initialGoogleError,
  saveProfile,
  saveServices,
  refresh,
  onSignOut,
}: {
  data: Extract<ScreenData, { kind: "account" }> | null;
  user: Person;
  busy: boolean;
  initialGoogleError: string;
  saveProfile: (name: string, username: string) => Promise<void>;
  saveServices: (ids: string[]) => Promise<void>;
  refresh: () => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const interactive = useInteractive();
  const [googleError, setGoogleError] = useState(initialGoogleError);
  const [connectingGoogle, setConnectingGoogle] = useState(false);
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">YOUR ACCOUNT</p>
        <h1>One you. One circle.</h1>
        <p>
          Keep the same profile and friendships when you change sign-in methods.
        </p>
        <Link
          className="secondary button"
          href={`/people/${user.username}`}
          prefetch={false}
        >
          View your profile
        </Link>
      </div>
      <AccountProfileEditor user={user} save={saveProfile} />
      <ActivityEmailSetting
        enabled={data?.activityEmail ?? null}
        refresh={refresh}
      />
      <StreamingServicesEditor
        services={data?.services ?? []}
        serviceIds={data?.serviceIds ?? null}
        save={saveServices}
      />
      {data?.kind === "account" && (
        <section className="settings-card">
          <h2>Sign-in methods</h2>
          <p>
            Email codes sign you in to this same account. Use the email address
            you joined with.
          </p>
          {googleError && (
            <p className="error" role="alert">
              {googleError}
            </p>
          )}
          {data.googleConnected ? (
            <p role="status">Google connected.</p>
          ) : data.googleEnabled ? (
            <>
              <p>
                Connect Google to add another way to sign in. Choose the Google
                account with the same email address.
              </p>
              <button
                className="secondary"
                disabled={busy || connectingGoogle || !interactive}
                onClick={async () => {
                  setConnectingGoogle(true);
                  setGoogleError("");
                  try {
                    const result = await authClient.linkSocial({
                      provider: "google",
                      callbackURL: "/account",
                      errorCallbackURL: "/account",
                      disableRedirect: true,
                    });
                    if (result.error)
                      throw new Error(
                        result.error.message ??
                          "Google could not be connected. Please try again.",
                      );
                    if (!result.data?.url)
                      throw new Error(
                        "Google sign-in did not start. Please try again.",
                      );
                    window.location.assign(result.data.url);
                  } catch (error) {
                    setGoogleError((error as Error).message);
                    setConnectingGoogle(false);
                  }
                }}
              >
                {connectingGoogle ? "Connecting…" : "Connect Google"}
              </button>
            </>
          ) : (
            <p className="muted">Google sign-in is not configured yet.</p>
          )}
          <hr />
          <button
            className="text-button"
            disabled={busy || !interactive || connectingGoogle}
            onClick={() => void onSignOut()}
          >
            Sign out
          </button>
        </section>
      )}
    </>
  );
}
