"use client";
import { useRef, useState } from "react";
import { useInteractive } from "./client";

export function StreamingServicesEditor({
  services,
  serviceIds,
  save,
}: {
  services: { id: string; name: string }[];
  serviceIds: string[] | null;
  save: (ids: string[]) => Promise<void>;
}) {
  const interactive = useInteractive();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const restoreFocus = useRef(false);
  function close() {
    restoreFocus.current = true;
    setDraft(null);
    setError("");
  }
  const visible = services.filter((service) =>
    service.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <section
      className="settings-card streaming-settings"
      aria-labelledby="streaming-heading"
    >
      <h2 id="streaming-heading">Your streaming services</h2>
      <p>
        Choose the services you have. Free options are always included when
        finding something to watch.
      </p>
      {draft ? (
        <form
          aria-label="Edit streaming services"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              await save(draft);
              close();
              setSaved(true);
            } catch (failure) {
              setError((failure as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Find a service
            <input
              autoFocus
              type="search"
              value={query}
              disabled={busy}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <p className="small muted" role="status">
            {draft.length} selected
          </p>
          <div
            className="service-options"
            role="group"
            aria-label="Streaming services"
          >
            {visible.map((service) => (
              <label key={service.id} className="service-option">
                <input
                  type="checkbox"
                  checked={draft.includes(service.id)}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft(
                      event.target.checked
                        ? [...draft, service.id]
                        : draft.filter((id) => id !== service.id),
                    )
                  }
                />
                <span>{service.name}</span>
              </label>
            ))}
            {!visible.length && <p>No services match that name.</p>}
          </div>
          <div className="inline-actions">
            <button className="primary" disabled={busy}>
              {busy ? "Saving…" : "Save services"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy || !draft.length}
              onClick={() => setDraft([])}
            >
              Clear selections
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        <>
          <p>
            {serviceIds === null
              ? "Services could not be loaded."
              : serviceIds.length
                ? services
                    .filter((service) => serviceIds.includes(service.id))
                    .map((service) => service.name)
                    .join(", ")
                : "No services selected."}
          </p>
          <button
            className="secondary"
            disabled={!interactive || serviceIds === null}
            ref={(button) => {
              if (button && restoreFocus.current) {
                restoreFocus.current = false;
                button.focus();
              }
            }}
            onClick={() => {
              setDraft([...(serviceIds ?? [])]);
              setQuery("");
              setSaved(false);
              setError("");
            }}
          >
            Edit services
          </button>
        </>
      )}
      <p className="small" role="status" aria-atomic="true">
        {saved ? "Services saved." : ""}
      </p>
    </section>
  );
}
