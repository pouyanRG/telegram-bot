import { lt, sql } from "drizzle-orm";
import { getDb } from "./db";
import { quotas } from "./schema";
import { LIMITS, type Feature } from "./config";

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function consumeQuota(userId: number, feature: Feature) {
  const limit = LIMITS[feature];

  const rows = await getDb()
    .insert(quotas)
    .values({ userId, feature, day: today(), used: 1 })
    .onConflictDoUpdate({
      target: [quotas.userId, quotas.feature, quotas.day],
      set: { used: sql`${quotas.used} + 1` },
      setWhere: lt(quotas.used, limit),
    })
    .returning({ used: quotas.used });

  return { allowed: rows.length > 0, used: rows[0]?.used ?? limit, limit };
}
