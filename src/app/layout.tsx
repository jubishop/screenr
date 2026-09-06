import type { Metadata } from "next";
import "./style.css";
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
