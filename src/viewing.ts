import type { TitleViewing, ViewingAccess } from "./shared";

export function matchingServices(
  viewing: TitleViewing | undefined,
  serviceIds: string[],
) {
  return (
    viewing?.sections
      .find((section) => section.key === "subs")
      ?.services.filter((service) => serviceIds.includes(service.id))
      .map((service) => service.id) ?? []
  );
}

export function viewingAccess(
  viewing: TitleViewing | undefined,
  serviceIds: string[],
): ViewingAccess {
  if (!viewing || viewing.status === "unavailable") return "unknown";
  return matchingServices(viewing, serviceIds).length ||
    viewing.sections.some(
      (section) => section.key === "free" && section.services.length,
    )
    ? "available"
    : "unmatched";
}
