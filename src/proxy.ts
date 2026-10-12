import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

// The enforced policy from docs/deployment.md#provisioning. Next reads the
// nonce from the request's policy and adds it to the scripts it renders, so
// every page must render per request (see the root layout).
function contentSecurityPolicy(nonce: string) {
  // React's development builds use eval for error stacks; production never does.
  const evaluation =
    process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'${evaluation}`,
    // Next's image layout and React's style props render style attributes.
    "style-src 'self' 'unsafe-inline'",
    // Optimized posters come from Screenr; service logos come from TMDB.
    "img-src 'self' https://image.tmdb.org",
    // Trailers load only after Play: docs/title-catalog.md
    "frame-src https://www.youtube.com",
    // The offline page's service worker: docs/installation.md#offline-page
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const policy = contentSecurityPolicy(randomBytes(16).toString("base64"));
  const headers = new Headers(request.headers);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

// Build assets and optimized images never render a document.
export const config = {
  matcher: "/((?!_next/static/|_next/image).*)",
};
