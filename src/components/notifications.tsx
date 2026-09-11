"use client";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";
import type { NotificationPage } from "../server/notifications";
import { api, dateLabel, useInteractive } from "./client";

export function Notifications({
  count,
  refreshScreen,
}: {
  count: number | null;
  refreshScreen: () => Promise<void>;
}) {
  const interactive = useInteractive();
  const router = useRouter();
  const heading = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const bell = useRef<HTMLButtonElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [cursor, setCursor] = useState<{
    before: string;
    through: string;
  } | null>(null);
  const [page, setPage] = useState<NotificationPage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const refresh = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const query = new URLSearchParams({ unread: String(unreadOnly) });
    if (cursor) {
      query.set("before", cursor.before);
      query.set("through", cursor.through);
    }
    try {
      const result = await api<NotificationPage>(
        `notifications?${query}`,
        undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      );
      if (!controller.signal.aborted) {
        setPage(result);
        setError("");
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setPage(null);
        setError((failure as Error).message);
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }, [cursor, unreadOnly]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !pending.current)
        void refresh();
    }, 3000);
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      clearInterval(timer);
      pending.current?.abort();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const element = dialog.current!;
    const place = () => {
      const rect = bell.current!.getBoundingClientRect();
      setPosition({
        top: rect.bottom + 10,
        left: Math.max(16, Math.min(rect.left, window.innerWidth - 436)),
      });
    };
    place();
    element.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      document.body.style.overflow = overflow;
      element.close();
    };
  }, [open]);

  function show() {
    setCursor(null);
    setUnreadOnly(false);
    setPage(null);
    setError("");
    setOpen(true);
  }

  async function select(id: string) {
    if (busy) return;
    pending.current?.abort();
    setBusy(true);
    try {
      const result = await api<{ href: string }>("read-notification", { id });
      setOpen(false);
      void refreshScreen();
      router.push(result.href);
    } catch (failure) {
      setPage(null);
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function markAll() {
    if (busy || !page?.through) return;
    pending.current?.abort();
    setBusy(true);
    try {
      await api("read-notifications", { through: page.through });
      await Promise.all([refresh(), refreshScreen()]);
    } catch (failure) {
      setPage(null);
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const unread = open ? (page?.unread ?? count) : count;
  return (
    <>
      <button
        ref={bell}
        className="notification-bell"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!interactive}
        onClick={show}
      >
        <svg
          viewBox="0 0 24 24"
          width="23"
          height="23"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path
            d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"
            strokeLinejoin="round"
          />
          <path d="M9 20a3 3 0 0 0 6 0" strokeLinecap="round" />
        </svg>
        {!!unread && (
          <span className="notification-badge" aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      <dialog
        ref={dialog}
        className="notification-panel"
        aria-labelledby={heading}
        style={
          {
            "--panel-top": `${position.top}px`,
            "--panel-left": `${position.left}px`,
          } as CSSProperties
        }
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target !== dialog.current) return;
          const rect = dialog.current.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            setOpen(false);
        }}
      >
        <header className="notification-heading">
          <h2 id={heading}>Notifications</h2>
          <button
            className="text-button"
            onClick={() => setOpen(false)}
            aria-label="Close notifications"
          >
            Close
          </button>
        </header>
        <div className="notification-controls">
          <div
            role="group"
            aria-label="Filter notifications"
            className="notification-filters"
          >
            {([false, true] as const).map((onlyUnread) => (
              <button
                key={String(onlyUnread)}
                aria-pressed={unreadOnly === onlyUnread}
                disabled={busy}
                onClick={() => {
                  if (unreadOnly === onlyUnread && cursor === null) return;
                  setPage(null);
                  setCursor(null);
                  setUnreadOnly(onlyUnread);
                }}
              >
                {onlyUnread ? "Unread" : "All"}
              </button>
            ))}
          </div>
          <button
            className="text-button"
            disabled={busy || !page?.unread}
            onClick={() => void markAll()}
          >
            Mark all as read
          </button>
        </div>
        <div className="notification-content">
          {error ? (
            <div className="error" role="alert">
              {error}
              <button className="text-button" onClick={() => void refresh()}>
                Try again
              </button>
            </div>
          ) : !page ? (
            <p className="muted" role="status">
              Loading notifications…
            </p>
          ) : (
            <>
              {page.items.length ? (
                <ul className="notification-list">
                  {page.items.map((item) => (
                    <li key={item.id}>
                      <button
                        className={`notification-item${item.read ? "" : " unread"}`}
                        disabled={busy}
                        onClick={() => void select(item.id)}
                      >
                        <span className="avatar" aria-hidden="true">
                          {item.actor.slice(0, 1)}
                        </span>
                        <span className="notification-copy">
                          <span>{item.message}</span>
                          <time dateTime={item.createdAt}>
                            {dateLabel(item.createdAt, interactive, {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </time>
                        </span>
                        {!item.read && (
                          <span
                            className="notification-dot"
                            role="img"
                            aria-label="Unread"
                          />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="notification-empty">
                  <h3>
                    {unreadOnly
                      ? "You're all caught up."
                      : cursor
                        ? "No earlier notifications."
                        : "No notifications yet."}
                  </h3>
                  <p>
                    {unreadOnly
                      ? "New notifications will appear here."
                      : "Friend requests, new friendships, comments, and replies will appear here."}
                  </p>
                </div>
              )}
              <div className="notification-pagination">
                {cursor && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setPage(null);
                      setCursor(null);
                    }}
                  >
                    Latest notifications
                  </button>
                )}
                {page.next && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (!page.next || !page.through) return;
                      setPage(null);
                      setCursor({ before: page.next, through: page.through });
                    }}
                  >
                    Earlier notifications
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </dialog>
    </>
  );
}
