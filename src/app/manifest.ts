import type { MetadataRoute } from "next";

// Installable without offline content: docs/installation.md#home-screen-installation
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Screenr",
    short_name: "Screenr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f7f6f0",
    theme_color: "#f7f6f0",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
