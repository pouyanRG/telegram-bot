import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "./db";
import { voiceJobs } from "./schema";
import { VOICE } from "./config";
import { isUniqueViolation } from "./errors";

type StartResult =
  | { status: "ok"; id: number }
  | { status: "duplicate" }
  | { status: "busy" };

export async function startJob(p: {
  userId: number;
  chatId: number;
  messageId: number;
  fileUniqueId: string;
  declaredSec: number;
}): Promise<StartResult> {
  try {
    const [row] = await getDb()
      .insert(voiceJobs)
      .values(p)
      .onConflictDoNothing({ target: [voiceJobs.chatId, voiceJobs.messageId] })
      .returning({ id: voiceJobs.id });
    return row ? { status: "ok", id: row.id } : { status: "duplicate" };
  } catch (e) {
    // ایندکس جزئی «یک job فعال برای هر کاربر»
    if (isUniqueViolation(e)) return { status: "busy" };
    throw e;
  }
}

export async function finishJob(id: number, billedSec: number) {
  const rows = await getDb()
    .update(voiceJobs)
    .set({ status: "done", billedSec, finishedAt: new Date() })
    .where(and(eq(voiceJobs.id, id), eq(voiceJobs.status, "processing")))
    .returning({ id: voiceJobs.id });
  return rows.length > 0;
}

/** شکست job و رفاند اتمیک؛ فقط یک بار اجرا می‌شود (شرط status) */
export async function failJob(id: number) {
  await getDb().execute(sql`
    with j as (
      update voice_jobs
         set status = 'failed', finished_at = now()
       where id = ${id}::int and status = 'processing'
      returning user_id, charged_cost, charged_day
    )
    update quotas q
       set used = greatest(q.used - j.charged_cost, 0)
      from j
     where j.charged_cost > 0
       and q.user_id = j.user_id
       and q.feature = 'tokens'
       and q.day = j.charged_day
  `);
}

/** jobهای معلق‌مانده (مثلاً تابع وسط کار قطع شده) را fail و رفاند می‌کند */
export async function reapStaleJobs(userId: number) {
  const stale = await getDb()
    .select({ id: voiceJobs.id })
    .from(voiceJobs)
    .where(
      and(
        eq(voiceJobs.userId, userId),
        eq(voiceJobs.status, "processing"),
        lt(voiceJobs.createdAt, new Date(Date.now() - VOICE.staleJobMs))
      )
    );
  for (const s of stale) await failJob(s.id);
}