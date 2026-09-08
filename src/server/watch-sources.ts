import type { WatchAvailability, WatchProvider, WatchSection } from "../shared";
import registry from "./watch-provider-registry.json";

const english = new Intl.Collator("en", { sensitivity: "base" });
const byIdentity = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byName = (a: string, b: string) =>
  english.compare(a, b) || byIdentity(a, b);
const safeLogo = (path: string | null) =>
  path && /^\/[a-zA-Z0-9._-]+$/.test(path) ? path : null;
const members = new Map(
  registry.flatMap((service) =>
    service.members.map(
      (member) => [member.id, { service, via: member.via }] as const,
    ),
  ),
);

// Used for every cache result, including old rows. Registry metadata never
// creates an offer: only members reported in this section affect availability.
export function watchSections(
  providers: WatchAvailability["providers"],
): WatchSection[] {
  const sections: WatchSection[] = [];
  for (const [key, label, categories] of [
    ["subs", "Subs", ["flatrate"]],
    ["free", "Free", ["free", "ads"]],
  ] as const) {
    const groups = new Map<string, WatchProvider[]>();
    for (const category of categories) {
      for (const provider of providers[category] ?? []) {
        const member = members.get(provider.provider_id);
        const id = member
          ? `service:${member.service.key}`
          : `provider:${provider.provider_id}`;
        const group = groups.get(id) ?? [];
        group.push(provider);
        groups.set(id, group);
      }
    }
    const services = [...groups]
      .map(([id, offers]) => {
        // Stable choices even when TMDB changes order or repeats an ID across
        // free and ads with different names/logos. Prefer any safe logo to none.
        offers.sort(
          (a, b) =>
            a.provider_id - b.provider_id ||
            byName(a.provider_name, b.provider_name) ||
            byIdentity(
              safeLogo(a.logo_path) ?? "~",
              safeLogo(b.logo_path) ?? "~",
            ),
        );
        const service = members.get(offers[0].provider_id)?.service;
        const routes = offers.map(
          (offer) => members.get(offer.provider_id)?.via ?? null,
        );
        const resellers = [
          ...new Set(routes.filter((route): route is string => route !== null)),
        ].sort(byName);
        return {
          id,
          name: service?.name ?? offers[0].provider_name,
          logo_path:
            safeLogo(service?.logo_path ?? null) ??
            offers.map((offer) => safeLogo(offer.logo_path)).find(Boolean) ??
            null,
          route_note: routes.includes(null)
            ? null
            : `via ${resellers.join(", ")}`,
        };
      })
      .sort(
        (a, b) => english.compare(a.name, b.name) || byIdentity(a.id, b.id),
      );
    if (services.length) sections.push({ key, label, services });
  }
  return sections;
}
