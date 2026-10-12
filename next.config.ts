import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  agentRules: false,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
  // Some clients request Apple's conventional icon paths without reading the
  // page. Serve the app/apple-icon.png image instead of the member route.
  async rewrites() {
    return ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"].map(
      (source) => ({ source, destination: "/apple-icon.png" }),
    );
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "image.tmdb.org", pathname: "/t/p/**" },
    ],
  },
};
export default config;
