"use client";
import { useState } from "react";
import type { ScreenData } from "../server/screens";
import type { Person } from "../shared";
import { authClient, signOut, useInteractive } from "./client";
import { useActionError } from "./action-error";
import { ActionButton } from "./action-button";
import { AccountProfileEditor } from "./account-profile-editor";
import { StreamingServicesEditor } from "./streaming-services-editor";
import { ActivityEmailSetting } from "./activity-email-setting";
export function AccountView({
  data,
  user,
  initialGoogleError,
  saveProfile,
  saveServices,
  refresh,
}: {
  data: Extract<ScreenData, { kind: "account" }> | null;
  user: Person;
  initialGoogleError: string;
  saveProfile: (name: string, username: string) => Promise<void>;
  saveServices: (ids: string[]) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const interactive = useInteractive();
  const [googleError, setGoogleError] = useState(initialGoogleError);
  const [connectingGoogle, setConnectingGoogle] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const signOutFailure = useActionError();
  return (
    <>
      <div className="page-heading">
        <h1 className="page-title">Account</h1>
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
        <section className="settings-card" aria-labelledby="sign-in-heading">
          <h2 id="sign-in-heading">Sign-in methods</h2>
          <p>
            Keep the same profile and friendships when you change sign-in
            methods.
          </p>
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
              <ActionButton
                className="secondary"
                disabled={!interactive}
                unavailable={signingOut || connectingGoogle}
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
              </ActionButton>
            </>
          ) : (
            <p className="muted">Google sign-in is not configured yet.</p>
          )}
          <hr />
          <ActionButton
            className="text-button"
            disabled={!interactive}
            unavailable={signingOut || connectingGoogle}
            aria-describedby={signOutFailure.describedBy("sign-out")}
            onClick={async () => {
              setSigningOut(true);
              await signOutFailure.run("sign-out", signOut);
              setSigningOut(false);
            }}
          >
            Sign out
          </ActionButton>
          {signOutFailure.alert}
        </section>
      )}
    </>
  );
}
