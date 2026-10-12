"use client";
import { useEffect, useRef, useState } from "react";
import type { Trailer } from "../shared";
import { useInteractive } from "./client";

// Nothing loads from YouTube until the viewer presses Play trailer.
export function TitleTrailer({
  name,
  trailer,
}: {
  name: string;
  trailer: Trailer;
}) {
  const interactive = useInteractive();
  const [open, setOpen] = useState(false);
  const player = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (open) player.current?.focus();
  }, [open]);
  return (
    <section className="title-trailer" aria-labelledby="trailer-heading">
      <h2 id="trailer-heading" className="sr-only">
        Trailer
      </h2>
      <div className="inline-actions">
        {!open && (
          <button
            className="secondary"
            disabled={!interactive}
            onClick={() => setOpen(true)}
          >
            <span aria-hidden="true">▶&#xFE0E;</span> Play trailer
          </button>
        )}
        <a
          href={`https://www.youtube.com/watch?v=${trailer.key}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Watch on YouTube
        </a>
      </div>
      {open && (
        <>
          <iframe
            ref={player}
            className="trailer-player"
            src={`https://www.youtube.com/embed/${trailer.key}?autoplay=1&playsinline=1`}
            title={`${name} trailer: ${trailer.name}`}
            referrerPolicy="strict-origin-when-cross-origin"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
          />
          <p className="small muted">
            If the trailer cannot play here, watch it on YouTube.
          </p>
        </>
      )}
    </section>
  );
}
