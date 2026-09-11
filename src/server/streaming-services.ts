import { AppError, db, transaction } from "./db";
import registry from "./watch-provider-registry.json";

export const streamingServices = registry
  .map((service) => ({
    id: `service:${service.key}`,
    name: service.name,
  }))
  .sort(
    (a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
const knownServices = new Set(streamingServices.map((service) => service.id));

export async function savedServices(userId: string): Promise<string[]> {
  const { rows } = await db.query<{ service_id: string }>(
    "SELECT service_id FROM member_streaming_service WHERE user_id=$1 ORDER BY service_id",
    [userId],
  );
  return rows.map((row) => row.service_id);
}

export async function saveServices(userId: string, value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length > streamingServices.length ||
    value.some((id) => typeof id !== "string" || !knownServices.has(id))
  )
    throw new AppError("Choose services from the list.");
  const serviceIds = [...new Set(value as string[])].sort();
  await transaction(async (client) => {
    await client.query(
      "DELETE FROM member_streaming_service WHERE user_id=$1",
      [userId],
    );
    await client.query(
      `INSERT INTO member_streaming_service(user_id,service_id)
      SELECT $1,unnest($2::text[])`,
      [userId, serviceIds],
    );
  });
  return { serviceIds };
}
