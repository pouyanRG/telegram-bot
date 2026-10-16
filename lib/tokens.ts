import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { quotas, users } from "./schema";
import { TOKENS } from "./config";

export const todayKey = () => new Date().toISOString().slice(0, 10);

export const dailyLimit = (isPro: boolean) =>
  isPro ? TOKENS.dailyPro : TOKENS.dailyFree;

export async function getUserState(userId: number) {
  const [u] = await getDb()
    .select({ isBanned: users.isBanned, proUntil: users.proUntil })
    .from(users)
    .where(eq(users.telegramId, userId));
  if (!u) return null;
  return {
    isBanned: u.isBanned,
    isPro: !!u.proUntil && u.proUntil.getTime() > Date.now(),
  };
}

export async function getUsedToday(userId: number) {
  const [row] = await getDb()
    .select({ used: quotas.used })
    .from(quotas)
    .where(
      and(
        eq(quotas.userId, userId),
        eq(quotas.feature, "tokens"),
        eq(quotas.day, todayKey())
      )
    );
  return row?.used ?? 0;
}

/**
 * کسر اتمیک توکن + ثبت مبلغ کسرشده روی job، در یک دستور.
 * شرط‌ها: کاربر مسدود نباشد، used + cost <= limit، job هنوز processing باشد.
 * اگر چیزی برنگردد یعنی کسر انجام نشده.
 */
export async function chargeJob(p: {
  jobId: number;
  userId: number;
  cost: number;
  limit: number;
}) {
  const day = todayKey();
  const rows = (await getDb().execute(sql`
    with ok as (
      insert into quotas (user_id, feature, day, used)
      select ${p.userId}::bigint, 'tokens', ${day}::text, ${p.cost}::int
      where ${p.cost}::int <= ${p.limit}::int
        and exists (
          select 1 from users
          where telegram_id = ${p.userId}::bigint and is_banned = false
        )
      on conflict (user_id, feature, day)
      do update set used = quotas.used + ${p.cost}::int
        where quotas.used + ${p.cost}::int <= ${p.limit}::int
      returning used
    )
    update voice_jobs
       set charged_cost = ${p.cost}::int, charged_day = ${day}::text
     where id = ${p.jobId}::int
       and status = 'processing'
       and exists (select 1 from ok)
    returning (select used from ok) as used
  `)) as unknown as { used: number }[];

  return rows.length > 0 ? { used: Number(rows[0].used) } : null;
}