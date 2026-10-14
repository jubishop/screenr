"use client";
import { useState } from "react";
import { codeLimitMessage } from "../shared";
import { loginPath, setupPath } from "../member-routes";
import { authClient, api, signOut, useInteractive } from "./client";
import { ActionButton } from "./action-button";
import { PhotoEditor, sendPhoto } from "./photo-editor";

// `next` is the validated member path to return to after sign-in.
export function SignIn({
  invited,
  googleEnabled,
  initialError,
  notice = "",
  next,
}: {
  invited: boolean;
  googleEnabled: boolean;
  initialError: string;
  // A result to report on arrival, such as a deleted account.
  notice?: string;
  next?: string;
}) {
  const interactive = useInteractive();
  const [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(initialError);
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = sent
        ? await authClient.signIn.emailOtp({ email, otp: code })
        : await authClient.emailOtp.sendVerificationOtp({
            email,
            type: "sign-in",
          });
      if (result.error)
        throw new Error(
          // Better Auth's per-IP limit has a generic message.
          !sent && result.error.status === 429
            ? codeLimitMessage
            : (result.error.message ?? "Could not sign in."),
        );
      if (sent) window.location.assign(setupPath(next));
      else setSent(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <a className="brand" href="/">
        screenr<span>●</span>
      </a>
      <section className="auth-card">
        <p className="eyebrow">BETTER WITH FRIENDS</p>
        <h1>
          Your next great watch
          <br />
          starts with a friend.
        </h1>
        <p className="muted">
          {invited
            ? "You’re invited. Sign in to find your people and something worth watching."
            : "Welcome back. Sign in to your circle. New members need an invitation."}
        </p>
        {notice && <p role="status">{notice}</p>}
        {googleEnabled && (
          <ActionButton
            className="secondary wide"
            disabled={!interactive}
            unavailable={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const result = await authClient.signIn.social({
                  provider: "google",
                  callbackURL: setupPath(next),
                  errorCallbackURL: loginPath(next),
                  disableRedirect: true,
                });
                if (result.error)
                  throw new Error(
                    result.error.message ||
                      "Google sign-in failed. Please try again.",
                  );
                if (!result.data?.url)
                  throw new Error(
                    "Google sign-in did not start. Please try again.",
                  );
                window.location.assign(result.data.url);
              } catch (error) {
                setError((error as Error).message);
                setBusy(false);
              }
            }}
          >
            Continue with Google
          </ActionButton>
        )}
        {googleEnabled && <div className="divider">or use an email code</div>}
        <form onSubmit={submit}>
          <label>
            Email address
            <input
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              disabled={sent || !interactive}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {sent && (
            <label>
              Sign-in code
              <input
                disabled={!interactive}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
              />
            </label>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <ActionButton
            className="primary wide"
            disabled={!interactive}
            unavailable={busy}
          >
            {busy ? "One moment…" : sent ? "Sign in" : "Send sign-in code"}
          </ActionButton>
          {sent && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setSent(false);
                setCode("");
              }}
            >
              Use another email or request a new code
            </button>
          )}
        </form>
        <p className="small muted">
          No password to remember. Your conversations stay within your circle.
        </p>
      </section>
      <p className="small muted auth-links">
        <a href="/credits">Catalog credits</a>
        <a href="/privacy">Privacy policy</a>
      </p>
    </main>
  );
}

export function Setup({
  userId,
  email,
  name,
  verified,
  next,
  photo: initialPhoto,
  google,
}: {
  userId: string;
  email: string;
  name: string;
  verified: boolean;
  next?: string;
  photo: string | null;
  google: boolean;
}) {
  const interactive = useInteractive();
  const [photo, setPhoto] = useState(initialPhoto);
  const [displayName, setName] = useState(name),
    [username, setUsername] = useState(""),
    [code, setCode] = useState(""),
    [sent, setSent] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!verified) {
        const result = sent
          ? await authClient.emailOtp.verifyEmail({ email, otp: code })
          : await authClient.emailOtp.sendVerificationOtp({
              email,
              type: "email-verification",
            });
        if (result.error) throw new Error(result.error.message);
        if (sent) window.location.reload();
        else setSent(true);
      } else {
        await api("setup", { name: displayName, username });
        window.location.assign(next ?? "/");
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <a className="brand" href="/">
        screenr<span>●</span>
      </a>
      <section className="auth-card">
        <p className="eyebrow">MAKE YOURSELF AT HOME</p>
        <h1>
          {verified ? "What should friends call you?" : "Verify your email"}
        </h1>
        <p className="muted">
          {verified
            ? "Two details, and you’re in. Joining through a member’s invitation automatically makes you friends with them."
            : `Confirm ownership of ${email} to finish joining.`}
        </p>
        <form onSubmit={submit}>
          {verified ? (
            <>
              <label>
                Display name
                <input
                  disabled={!interactive}
                  required
                  maxLength={60}
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                Username
                <input
                  disabled={!interactive}
                  required
                  pattern="[a-zA-Z0-9_]{3,24}"
                  maxLength={24}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-describedby="username-help"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </label>
              <p id="username-help" className="small muted">
                3–24 letters, numbers, or underscores.
              </p>
              <fieldset className="setup-photo">
                <legend>Profile photo (optional)</legend>
                <PhotoEditor
                  person={{ user_id: userId, display_name: displayName, photo }}
                  google={google}
                  save={async (change) =>
                    setPhoto((await sendPhoto(change)).photo)
                  }
                />
              </fieldset>
            </>
          ) : (
            sent && (
              <label>
                Email code
                <input
                  disabled={!interactive}
                  required
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
            )
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <ActionButton
            className="primary wide"
            disabled={!interactive}
            unavailable={busy}
          >
            {busy
              ? "One moment…"
              : verified
                ? "Join Screenr"
                : sent
                  ? "Verify email"
                  : "Send verification code"}
          </ActionButton>
        </form>
        <ActionButton
          disabled={!interactive}
          unavailable={busy}
          className="text-button"
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await signOut();
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Sign out
        </ActionButton>
      </section>
    </main>
  );
}
