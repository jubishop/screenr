import type { Metadata } from "next";
// Load shared defaults before the feature styles that build on them.
import "./style.css";
import "./styles/layout.css";
import "./styles/auth.css";
import "./styles/people.css";
import "./styles/titles.css";
import "./styles/feeds.css";
export const metadata: Metadata = {
  title: "Screenr · Better with friends",
  description: "Find your next movie or show through your friends.",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
