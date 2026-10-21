import type { Context, NextFunction } from "grammy";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { processedUpdates, users } from "./schema";

// ---------- پاک‌سازی دوره‌ای ----------

async function housekeeping() {
  const db = getDb();
  const steps = [
    sql`delete from processed_updates where created_at < now() - interval '2 days'`,
    sql`delete from cache
        where (key like 'admin_login:%'
               and (data->>'resetAt')::bigint < (extract(epoch from now()) * 1000)::bigint)
           or (key like 'pending_sticker:%' and updated_at < now() - interval '1 day')
           or (key like 'profile_step:%' and updated_at < now() - interval '7 days')
           or (key like 'coin:%' and updated_at < now() - interval '1 day')
           or (key like 'pedit:%' and updated_at < now() - interval '1 day')
           or (key like 'news:%' and updated_at < now() - interval '1 day')`,
    sql`delete from quotas where day < to_char(now() - interval '30 days', 'YYYY-MM-DD')`,
    sql`delete from voice_jobs
        where status <> 'processing' and created_at < now() - interval '30 days'`,
  ];
  for (const s of steps) {
    await db.execute(s).catch((e) => console.error("housekeeping error:", e));
  }
}

// ---------- ضد پردازش تکراری ----------

/** هر update_id فقط یک بار پردازش می‌شود (تلگرام در تأخیر/خطا آپدیت را دوباره می‌فرستد) */
export async function dedupeUpdates(ctx: Context, next: NextFunction) {
  try {
    const rows = await getDb()
      .insert(processedUpdates)
      .values({ updateId: ctx.update.update_id })
      .onConflictDoNothing()
      .returning({ id: processedUpdates.updateId });
    if (rows.length === 0) return; // تکراری

    // حدود هر ۲۰۰ آپدیت یک بار پاک‌سازی
    if (Math.random() < 0.005) await housekeeping();
  } catch (e) {
    // اگر دیتابیس مشکل داشت، userGuard خودش خطا را به کاربر نشان می‌دهد
    console.error("dedupeUpdates error:", e);
  }
  await next();
}

// ---------- کاربر ----------

// فقط هر چند دقیقه یک بار lastSeenAt را می‌نویسیم، نه روی هر آپدیت
const TOUCH_MS = 5 * 60 * 1000;

export async function userGuard(ctx: Context, next: NextFunction) {
  if (!ctx.from || ctx.chat?.type !== "private") {
    // بدون پاسخ، دکمه در تلگرام تا چند ثانیه «در حال بارگذاری» می‌ماند
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    return;
  }

  const from = ctx.from;
  const username = from.username ?? null;
  const firstName = from.first_name ?? null;
  const language = from.language_code ?? null;

  try {
    const db = getDb();

    // خواندن همیشه انجام می‌شود (وضعیت مسدودی باید لحظه‌ای باشد)، نوشتن فقط در صورت نیاز
    const [cur] = await db
      .select({
        isBanned: users.isBanned,
        lastSeenAt: users.lastSeenAt,
        username: users.username,
        firstName: users.firstName,
        language: users.language,
      })
      .from(users)
      .where(eq(users.telegramId, from.id));

    let isBanned: boolean;
    if (
      cur &&
      cur.username === username &&
      cur.firstName === firstName &&
      cur.language === language &&
      Date.now() - cur.lastSeenAt.getTime() < TOUCH_MS
    ) {
      isBanned = cur.isBanned;
    } else {
      const [row] = await db
        .insert(users)
        .values({ telegramId: from.id, username, firstName, language })
        .onConflictDoUpdate({
          target: users.telegramId,
          set: { username, firstName, language, lastSeenAt: sql`now()` },
        })
        .returning({ isBanned: users.isBanned });
      isBanned = !!row?.isBanned;
    }

    if (isBanned) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      await ctx.reply("⛔️ دسترسی شما به ربات مسدود شده است.");
      return;
    }
  } catch (e) {
    console.error("userGuard DB error:", e);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply("⚠️ مشکل موقت. کمی بعد دوباره امتحان کن.").catch(() => {});
    return;
  }

  await next();
}