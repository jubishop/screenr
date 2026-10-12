"use client";
import { useEffect } from "react";

// public/sw.js only shows an offline page for failed page loads. Without
// service worker support, browsers keep their own offline error.
export function OfflineWorker() {
  useEffect(() => {
    navigator.serviceWorker?.register("/sw.js").catch(() => {});
  }, []);
  return null;
}
