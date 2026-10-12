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
// The Content-Security-Policy in src/proxy.ts runs only scripts that carry the
// request's nonce, which Next adds when it renders. Render every page per
// request; a prerendered page's scripts would be blocked.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Screenr · Better with friends",
  description: "Find your next movie or show through your friends.",
  robots: { index: false, follow: false },
  // Icons and the manifest come from the app/ file conventions.
  appleWebApp: { title: "Screenr" },
};
// Pages extend under the device's safe areas and pad themselves clear of them.
// The theme follows the device's appearance setting; each theme color matches
// that theme's --paper in style.css.
export const viewport: Viewport = {
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f6f0" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1a17" },
  ],
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
