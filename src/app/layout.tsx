import type { Metadata, Viewport } from "next";
// Load shared defaults before the feature styles that build on them.
import "./style.css";
import "./styles/layout.css";
import "./styles/auth.css";
import "./styles/people.css";
import "./styles/titles.css";
import "./styles/feeds.css";
import "./styles/notifications.css";
import { OfflineWorker } from "../components/offline-worker";
export const metadata: Metadata = {
  title: "Screenr · Better with friends",
  description: "Find your next movie or show through your friends.",
  robots: { index: false, follow: false },
  // Icons and the manifest come from the app/ file conventions.
  appleWebApp: { title: "Screenr" },
};
// Pages extend under the device's safe areas and pad themselves clear of them.
export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: "#f7f6f0",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <OfflineWorker />
      </body>
    </html>
  );
}
