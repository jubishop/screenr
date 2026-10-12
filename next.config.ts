import type { NextConfig } from "next";

// Trailers delegate these features to YouTube's player: docs/title-catalog.md
const youtube = [
  "autoplay",
  "encrypted-media",
  "fullscreen",
  "picture-in-picture",
];
// Deny browser features Screenr does not use: docs/deployment.md#provisioning
// Unlisted features, such as the clipboard and sharing, keep browser defaults.
const denied = [
  "accelerometer",
  "bluetooth",
  "browsing-topics",
  "camera",
  "display-capture",
  "gamepad",
  "geolocation",
  "gyroscope",
  "hid",
  "identity-credentials-get",
  "idle-detection",
  "local-fonts",
  "magnetometer",
  "microphone",
  "midi",
  "otp-credentials",
  "payment",
  "publickey-credentials-get",
  "screen-wake-lock",
  "serial",
  "usb",
  "window-management",
  "xr-spatial-tracking",
];
const permissionsPolicy = [
  ...youtube.map((feature) => `${feature}=(self "https://www.youtube.com")`),
  ...denied.map((feature) => `${feature}=()`),
].join(", ");

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
          // One year, without the browser preload list. Cloudflare adds none.
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "Permissions-Policy", value: permissionsPolicy },
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
