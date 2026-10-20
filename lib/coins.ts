import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { users } from "./schema";
import { COINS } from "./config";

export async function getCoins(userId: number) {
  const [r] = await getDb()
    .select({ coins: users.coins })
    .from(users)
    .where(eq(users.telegramId, userId));
  return r?.coins ?? 0;
}

export async function addCoins(userId: number, amount: number) {
  const [r] = await getDb()
    .update(users)
    .set({ coins: sql`${users.coins} + ${amount}` })
    .where(eq(users.telegramId, userId))
    .returning({ coins: users.coins });
  return r?.coins ?? null;
}

/** کسر اتمیک؛ فقط بعد از موفق بودن درخواست صدا بزن. null یعنی سکه کافی نیست */
export async function spendCoins(userId: number, amount: number) {
  const [r] = await getDb()
    .update(users)
    .set({ coins: sql`${users.coins} - ${amount}` })
    .where(and(eq(users.telegramId, userId), gte(users.coins, amount)))
    .returning({ coins: users.coins });
  return r?.coins ?? null;
}

/** هدیه‌ی تکمیل پروفایل؛ فقط یک بار و فقط اگر پروفایل واقعاً کامل باشد */
export async function grantProfileReward(userId: number) {
  const [r] = await getDb()
    .update(users)
    .set({
      coins: sql`${users.coins} + ${COINS.profileReward}`,
      profileRewarded: true,
    })
    .where(
      and(
        eq(users.telegramId, userId),
        eq(users.profileRewarded, false),
        isNotNull(users.gender),
        isNotNull(users.age),
        isNotNull(users.province)
      )
    )
    .returning({ coins: users.coins });
  return r ? COINS.profileReward : null;
}