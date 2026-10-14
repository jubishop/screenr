"use client";
import { useEffect, useId, useRef, useState } from "react";
import { codeLimitMessage } from "../shared";
import { api, authClient, useInteractive } from "./client";
import { ActionButton } from "./action-button";
import { useActionError } from "./action-error";
import { ConfirmAction, Confirmation } from "./confirmation";

// Account deletion (docs/data-and-access.md#account-deletion). The member
// first confirms it's them by signing in again with an emailed code, since
// the server deletes only from a sign-in in the last ten minutes, and then
// confirms the deletion itself.
export function AccountDeletion({ email }: { email: string }) {
  const interactive = useInteractive();
  const [step, setStep] = useState<"closed" | "verify" | "code" | "confirm">(
    "closed",
  );
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const failure = useActionError();
  const prompt = useId();
  const start = useRef<HTMLButtonElement>(null);
  // Cancel returns focus to Delete account.
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (step !== "closed" || !restoreFocus.current) return;
    restoreFocus.current = false;
    start.current?.focus();
  }, [step]);
  function cancel() {
    restoreFocus.current = true;
    failure.clear();
    setCode("");
    setStep("closed");
  }
  async function sendCode() {
    setBusy(true);
    const sent = await failure.run("send", async () => {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
      });
      if (result.error)
        throw new Error(
          // Better Auth's per-IP limit has a generic message.
          result.error.status === 429
            ? codeLimitMessage
            : (result.error.message ?? "Could not send a code."),
        );
    });
    setBusy(false);
    if (sent) setStep("code");
  }
  async function confirmCode(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    // A successful sign-in replaces this browser's session with a fresh one.
    const confirmed = await failure.run("code", async () => {
      const result = await authClient.signIn.emailOtp({
        email,
        otp: code.trim(),
      });
      if (result.error)
        throw new Error(result.error.message ?? "Could not confirm the code.");
    });
    setBusy(false);
    if (confirmed) setStep("confirm");
  }
  return (
    <section className="settings-card" aria-labelledby="delete-account-heading">
      <h2 id="delete-account-heading">Delete account</h2>
      <p>
        Deleting your account erases your profile, photo, friendships,
        invitations, recommendations, watch statuses, reviews, top 10,
        reactions, and notifications right away. Your posts, reviews, and
        comments about titles are removed with their conversations. A comment of
        yours in someone else&rsquo;s conversation that has replies becomes
        &ldquo;Comment removed&rdquo; so the replies remain. This can&rsquo;t be
        undone.
      </p>
      {step === "closed" && (
        <ActionButton
          ref={start}
          className="danger"
          disabled={!interactive}
          unavailable={false}
          onClick={() => setStep("verify")}
        >
          Delete account
        </ActionButton>
      )}
      {step === "verify" && (
        <Confirmation
          message={`First, confirm it’s you. We’ll email a sign-in code to ${email}.`}
          action="Email me a code"
          busy={busy}
          onConfirm={() => void sendCode()}
          onCancel={cancel}
          describedBy={failure.describedBy("send")}
        >
          {failure.alert}
        </Confirmation>
      )}
      {step === "code" && (
        <form
          className="confirmation"
          aria-labelledby={prompt}
          onSubmit={confirmCode}
        >
          <p id={prompt}>
            Enter the sign-in code we emailed to {email}. It expires in 10
            minutes.
          </p>
          <label>
            Sign-in code
            <input
              autoFocus
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              value={code}
              readOnly={busy}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <div className="confirmation-actions">
            <ActionButton
              className="primary"
              unavailable={busy}
              aria-describedby={failure.describedBy("code")}
            >
              Confirm code
            </ActionButton>
            <ActionButton
              type="button"
              className="secondary"
              unavailable={busy}
              onClick={cancel}
            >
              Cancel
            </ActionButton>
          </div>
          {failure.alert}
        </form>
      )}
      {step === "confirm" && (
        <ConfirmAction
          message="Delete your Screenr account permanently? This can’t be undone."
          action="Delete account"
          run={() => api("delete-account", {})}
          onDone={() => window.location.assign("/login?deleted=1")}
          onCancel={cancel}
        />
      )}
    </section>
  );
}
