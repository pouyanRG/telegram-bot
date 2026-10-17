import { and, eq, lt, sql } from "drizzle-orm";
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

/** برگرداندن یک واحد سهمیه (مثلاً وقتی ارز پیدا نشد یا API خطا داد) */
export async function refundQuota(userId: number, feature: Feature) {
  await getDb()
    .update(quotas)
    .set({ used: sql`greatest(${quotas.used} - 1, 0)` })
    .where(
      and(eq(quotas.userId, userId), eq(quotas.feature, feature), eq(quotas.day, today()))
    );
}