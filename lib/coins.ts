import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { coinTransactions, users } from "./schema";
import { COINS } from "./config";

/** دلیل هر تراکنش سکه؛ در دفتر ذخیره می‌شود */
export type CoinReason =
  | "opening_balance"
  | "profile_reward"
  | "referral_join"
  | "referral_complete"
  | "report_reward"
  | "purchase"
  | "daily_bonus"
  | "gender_search"
  | "direct_message"
  | "chat_request"
  | "notify_online"
  | "notify_chat_end"
  | "new_bio"
  | "admin_adjust"
  | "refund";

type Db = ReturnType<typeof getDb>;
/** نوع tx داخل getDb().transaction(...) */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** وقتی (userId, reason, ref) قبلاً ثبت شده باشد؛ یعنی همین تراکنش دوباره اجرا شده */
export class DuplicateRef extends Error {}

/**
 * هسته: تغییر موجودی + نوشتن ردیف دفتر، هر دو داخل tx دریافتی.
 * - برای کسر، شرط coins >= amount داخل خود UPDATE است (اتمیک).
 * - ref اختیاری است؛ اگر بدهی، ایندکس یکتای (user_id, reason, ref) جلوی ثبت دوباره را می‌گیرد
 *   (مثلاً referral_join با ref = آیدی کاربر دعوت‌شده).
 * - null یعنی کاربر نیست یا موجودی کافی نیست. DuplicateRef یعنی تکراری.
 */
async function applyDelta(
  tx: Tx,
  userId: number,
  delta: number,
  reason: CoinReason,
  ref?: string
): Promise<number | null> {
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error("coin amount must be a non-zero integer");
  }

  const [r] = await tx
    .update(users)
    .set({ coins: sql`${users.coins} + ${delta}` })
    .where(
      delta < 0
        ? and(eq(users.telegramId, userId), gte(users.coins, -delta))
        : eq(users.telegramId, userId)
    )
    .returning({ coins: users.coins });
  if (!r) return null;

  const ins = await tx
    .insert(coinTransactions)
    .values({ userId, amount: delta, reason, ref: ref ?? null, balanceAfter: r.coins })
    .onConflictDoNothing()
    .returning({ id: coinTransactions.id });
  if (ins.length === 0) throw new DuplicateRef();

  return r.coins;
}

async function run(fn: (tx: Tx) => Promise<number | null>) {
  try {
    return await getDb().transaction(fn);
  } catch (e) {
    if (e instanceof DuplicateRef) return null; // تراکنش رول‌بک شد
    throw e;
  }
}

// ---------- API معمولی (تراکنش مستقل) ----------

export async function getCoins(userId: number) {
  const [r] = await getDb()
    .select({ coins: users.coins })
    .from(users)
    .where(eq(users.telegramId, userId));
  return r?.coins ?? 0;
}

/** افزایش سکه. موجودی جدید، یا null (کاربر نیست / ref تکراری) */
export function addCoins(userId: number, amount: number, reason: CoinReason, ref?: string) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("amount must be > 0");
  return run((tx) => applyDelta(tx, userId, amount, reason, ref));
}

/** کسر اتمیک؛ فقط بعد از موفق بودن درخواست صدا بزن. null یعنی سکه کافی نیست (یا ref تکراری) */
export function spendCoins(userId: number, amount: number, reason: CoinReason, ref?: string) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("amount must be > 0");
  return run((tx) => applyDelta(tx, userId, -amount, reason, ref));
}

// ---------- نسخه‌ی داخل تراکنش بیرونی (مثلاً ذخیره‌ی بیو + کسر سکه با هم) ----------
// DuplicateRef را خودت بیرون بگیر.

export const addCoinsTx = (tx: Tx, userId: number, amount: number, reason: CoinReason, ref?: string) =>
  applyDelta(tx, userId, amount, reason, ref);

export const spendCoinsTx = (tx: Tx, userId: number, amount: number, reason: CoinReason, ref?: string) =>
  applyDelta(tx, userId, -amount, reason, ref);

// ---------- هدیه‌ی تکمیل پروفایل ----------

/** فقط یک بار و فقط اگر پروفایل واقعاً کامل باشد */
export async function grantProfileReward(userId: number) {
  return getDb().transaction(async (tx) => {
    const [r] = await tx
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
    if (!r) return null;

    await tx.insert(coinTransactions).values({
      userId,
      amount: COINS.profileReward,
      reason: "profile_reward",
      ref: "profile",
      balanceAfter: r.coins,
    });
    return COINS.profileReward;
  });
}

// ---------- برای پشتیبانی ----------

export async function getCoinHistory(userId: number, limit = 20) {
  return getDb()
    .select()
    .from(coinTransactions)
    .where(eq(coinTransactions.userId, userId))
    .orderBy(desc(coinTransactions.id))
    .limit(limit);
}