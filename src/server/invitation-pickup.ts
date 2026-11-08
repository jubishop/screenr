// Invitation links install the app on iPhone
// (docs/ios-app.md#invitation-links-install-the-app-on-iphone--2026-11-07).
// /join saves the invitation in this cookie, as it does for the web's sign-in
// and setup. On an iPhone without Screenr it then goes to the install link,
// and after the install the app picks the invitation up from Safari: its web
// authentication session shares Safari's persistent cookies, opens
// `pickupPath`, and ends at `pickupCallbackPath`, which iOS hands only to an
// app this domain lists for its web credentials.
export const invitationCookie = "screenr-invite";
export const pickupPath = "/api/invitation-pickup";
export const pickupCallbackPath = "/api/invitation-pickup/done";

// Every invitation token is 32 random bytes in base64url.
export const invitationFormat = /^[a-zA-Z0-9_-]{43}$/;

// Where an iPhone installs Screenr: SCREENR_IPHONE_INSTALL_URL, TestFlight's
// public link now and the App Store later. Without an https link, as in
// development and tests, invitation links open the web's sign-in everywhere.
export function iphoneInstallURL() {
  const value = process.env.SCREENR_IPHONE_INSTALL_URL?.trim();
  if (!value || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === "https:" ? url : undefined;
}

// iPhone browsers name it in their User-Agent; an iPad's Safari presents
// itself as a Mac.
export const iphoneBrowser = (headers: Headers) =>
  /\biPhone\b/.test(headers.get("user-agent") ?? "");
