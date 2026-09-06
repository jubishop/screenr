"use client";
import { useState } from "react";
import { authClient, api } from "./client";

export function SignIn({
  invited,
  googleEnabled,
  initialError,
}: {
  invited: boolean;
  googleEnabled: boolean;
  initialError: string;
}) {
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
        throw new Error(result.error.message ?? "Could not sign in.");
      if (sent) window.location.assign("/setup");
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
        {googleEnabled && (
          <button
            className="secondary wide"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const result = await authClient.signIn.social({
                provider: "google",
                callbackURL: "/setup",
                errorCallbackURL: "/login",
              });
              if (result.error) {
                setError(result.error.message ?? "Google sign-in failed.");
                setBusy(false);
              }
            }}
          >
            Continue with Google
          </button>
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
              disabled={sent}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {sent && (
            <label>
              Sign-in code
              <input
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
          <button className="primary wide" disabled={busy}>
            {busy ? "One moment…" : sent ? "Sign in" : "Send sign-in code"}
          </button>
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
      <a className="small muted" href="/credits">
        Catalog credits
      </a>
    </main>
  );
}

export function Setup({
  email,
  name,
  verified,
}: {
  email: string;
  name: string;
  verified: boolean;
}) {
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
        window.location.assign("/");
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
            ? "Two details, and you’re in. Joining does not automatically add any friends."
            : `Confirm ownership of ${email} to finish joining.`}
        </p>
        <form onSubmit={submit}>
          {verified ? (
            <>
              <label>
                Display name
                <input
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
                  required
                  pattern="[a-zA-Z0-9_]{3,24}"
                  maxLength={24}
                  autoComplete="username"
                  aria-describedby="username-help"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </label>
              <p id="username-help" className="small muted">
                3–24 letters, numbers, or underscores.
              </p>
            </>
          ) : (
            sent && (
              <label>
                Email code
                <input
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
          <button className="primary wide" disabled={busy}>
            {busy
              ? "One moment…"
              : verified
                ? "Join Screenr"
                : sent
                  ? "Verify email"
                  : "Send verification code"}
          </button>
        </form>
        <button
          className="text-button"
          onClick={async () => {
            await authClient.signOut();
            window.location.assign("/login");
          }}
        >
          Sign out
        </button>
      </section>
    </main>
  );
}
