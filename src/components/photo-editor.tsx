"use client";
import { useRef, useState } from "react";
import { api, useInteractive } from "./client";
import { useActionError } from "./action-error";
import { ActionButton } from "./action-button";
import { Avatar } from "./avatar";

export type PhotoChange = Blob | "remove" | "google";

const side = 512;
// Caddy accepts request bodies of at most 64 KB (ops/Caddyfile), so uploads
// stay under 60 KB, within the 200 KB maximum. A 512-pixel JPEG of that size
// keeps more detail than any avatar shows.
const uploadTarget = 60 * 1024;

// Crops the center square and resizes it to a 512×512 JPEG in the browser,
// so the server needs no image library. Reading the file through an image
// bitmap needs no blob: URL, which the content security policy disallows.
export async function preparePhoto(file: Blob) {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      "This photo could not be opened. Choose a JPEG or PNG image.",
    );
  }
  try {
    const crop = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = side;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare the photo.");
    // JPEG has no transparency; transparent areas become white.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, side, side);
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      (bitmap.width - crop) / 2,
      (bitmap.height - crop) / 2,
      crop,
      crop,
      0,
      0,
      side,
      side,
    );
    for (const quality of [0.86, 0.78, 0.7, 0.62, 0.54, 0.46]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
      if (blob && blob.size <= uploadTarget) return blob;
    }
  } finally {
    bitmap.close();
  }
  throw new Error("This photo could not be made small enough. Try another.");
}

export function sendPhoto(change: PhotoChange) {
  return change === "remove"
    ? api<{ photo: null }>("remove-photo", {})
    : change === "google"
      ? api<{ photo: string }>("google-photo", {})
      : api<{ photo: string }>("photo", change);
}

// Adds, replaces, or removes the signed-in person's photo, during setup and
// on Account. "Use my Google photo" appears with a Google sign-in.
export function PhotoEditor({
  person,
  google,
  save,
}: {
  person: { user_id: string; display_name: string; photo: string | null };
  google: boolean;
  save: (change: PhotoChange) => Promise<void>;
}) {
  const interactive = useInteractive();
  const file = useRef<HTMLInputElement>(null);
  const choose = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<"upload" | "google" | "remove" | null>(null);
  const [status, setStatus] = useState("");
  const failure = useActionError();
  async function change(
    control: "upload" | "google" | "remove",
    prepare: () => Promise<PhotoChange>,
    done: string,
  ) {
    setBusy(control);
    setStatus("");
    const saved = await failure.run(control, async () => save(await prepare()));
    setBusy(null);
    if (!saved) return;
    setStatus(done);
    // Removing hides its own button; keep focus on the photo controls.
    if (control === "remove") choose.current?.focus();
  }
  return (
    <div className="photo-editor">
      <Avatar person={person} />
      <div>
        <p className="small muted">
          {person.photo
            ? "Members who can see your profile see this photo."
            : "Your initial shows until you add a photo."}
        </p>
        <div className="inline-actions">
          <ActionButton
            ref={choose}
            type="button"
            className="secondary"
            disabled={!interactive}
            unavailable={busy !== null}
            aria-describedby={failure.describedBy("upload")}
            onClick={() => file.current?.click()}
          >
            {busy === "upload"
              ? "Saving…"
              : person.photo
                ? "Replace photo"
                : "Add photo"}
          </ActionButton>
          <input
            ref={file}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              // Choosing the same file again still triggers a change.
              event.target.value = "";
              if (chosen)
                void change(
                  "upload",
                  () => preparePhoto(chosen),
                  person.photo ? "Photo replaced." : "Photo added.",
                );
            }}
          />
          {google && (
            <ActionButton
              type="button"
              className="secondary"
              disabled={!interactive}
              unavailable={busy !== null}
              aria-describedby={failure.describedBy("google")}
              onClick={() =>
                void change(
                  "google",
                  async () => "google",
                  "Google photo added.",
                )
              }
            >
              {busy === "google" ? "Copying…" : "Use my Google photo"}
            </ActionButton>
          )}
          {person.photo && (
            <ActionButton
              type="button"
              className="secondary"
              disabled={!interactive}
              unavailable={busy !== null}
              aria-describedby={failure.describedBy("remove")}
              onClick={() =>
                void change("remove", async () => "remove", "Photo removed.")
              }
            >
              {busy === "remove" ? "Removing…" : "Remove photo"}
            </ActionButton>
          )}
        </div>
        <p className="small" role="status" aria-atomic="true">
          {status}
        </p>
        {failure.alert}
      </div>
    </div>
  );
}
