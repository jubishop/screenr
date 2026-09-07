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
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "image.tmdb.org", pathname: "/t/p/**" },
    ],
  },
};
export default config;
