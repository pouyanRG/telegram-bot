import { and, count, eq, isNull } from "drizzle-orm";
import { InlineKeyboard, Keyboard, type Bot, type Context } from "grammy";
import { getDb } from "./db";
import { bans, cache, reports, users } from "./schema";
import { COINS } from "./config";
import { addCoins } from "./coins";
import { hasAdminPermission, isAdminUser, ownerId, recordAdminAction } from "./admins";
import { mainMenu } from "./menu";

const HTML = { parse_mode: "HTML" as const };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const REPORT_BACK = "🔙 بازگشت";

// ترتیب این لیست با ایندکس داخل callback (rr:{i}:{target}) هماهنگ است؛ ترتیب را عوض نکن
const REASONS = [
  { btn: "تبلیغات سایت ها و ربات ها و کانال ها", why: "تبلیغات سایت‌ها و ربات‌ها و کانال‌ها" },
  { btn: "ایجاد مزاحمت", why: "ایجاد مزاحمت" },
  { btn: "پخش شماره موبایل یا اطلاعات شخصی دیگران", why: "پخش شماره موبایل یا اطلاعات شخصی دیگران" },
  { btn: "دیگر موارد...", why: "دیگر موارد" },
];

const WARN =
  "تمامی گزارشات بررسی خواهند شد و 🔴 ارسال گزارشات اشتباه موجب مسدود شدن شما خواهد شد.";

// ---------- وضعیت گزارش در حال ثبت (جدول cache) ----------

type RState = { target: number; reason: string };
const rkey = (id: number) => `report:${id}`;

async function setReport(id: number, data: RState) {
  await getDb()
    .insert(cache)
    .values({ key: rkey(id), data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}
async function getReport(id: number) {
  const [row] = await getDb().select().from(cache).where(eq(cache.key, rkey(id)));
  return (row?.data as RState | undefined) ?? null;
}
export async function clearReport(id: number) {
  await getDb().delete(cache).where(eq(cache.key, rkey(id)));
}
// ---------- کمکی‌ها ----------

async function userExists(userId: number) {
  const [user] = await getDb()
    .select({ id: users.telegramId })
    .from(users)
    .where(eq(users.telegramId, userId));
  return !!user;
}

async function adminOnly(ctx: Context) {
  if (ctx.from && (await hasAdminPermission(ctx.from.id, "reports_manage"))) return true;
  await ctx.answerCallbackQuery({ text: "⛔️ دسترسی بررسی گزارش‌ها را ندارید.", show_alert: true }).catch(() => {});
  return false;
}

async function edit(ctx: Context, text: string, reply_markup: InlineKeyboard) {
  try {
    await ctx.editMessageText(text, { ...HTML, reply_markup });
  } catch {
    await ctx.reply(text, { ...HTML, reply_markup });
  }
}

const quoteMsg = (ctx: Context) => {
  const id = ctx.callbackQuery?.message?.message_id;
  return id ? { reply_parameters: { message_id: id } } : {};
};

async function banUser(id: number, reason: string, actorId: number) {
  await getDb().transaction(async (tx) => {
    await tx.update(users).set({ isBanned: true, banUntil: null }).where(eq(users.telegramId, id));
    const [open] = await tx
      .select({ id: bans.id })
      .from(bans)
      .where(and(eq(bans.userId, id), isNull(bans.unbannedAt)))
      .limit(1);
    if (open) {
      await tx
        .update(bans)
        .set({ reason, bannedBy: String(actorId), banUntil: null, bannedAt: new Date() })
        .where(eq(bans.id, open.id));
    } else {
      await tx.insert(bans).values({ userId: id, reason, bannedBy: String(actorId) });
    }
  });
}

// ---------- ثبت گزارش ----------

async function createReport(p: { reporterId: number; targetId: number; reason: string; details: string }) {
  const db = getDb();
  const [dup] = await db
    .select({ id: reports.id })
    .from(reports)
    .where(
      and(eq(reports.reporterId, p.reporterId), eq(reports.targetId, p.targetId), eq(reports.status, "pending"))
    )
    .limit(1);
  if (dup) return "duplicate" as const;

  await db.insert(reports).values(p);
  return "ok" as const;
}

// ---------- ثبت هندلرها ----------

export function registerReports(bot: Bot) {
  // ===== گزارش کاربر =====
  bot.callbackQuery(/^rp:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const me = ctx.from.id;
    const target = Number(ctx.match[1]);

    if (target === me) return void (await ctx.reply("خودت را نمی‌توانی گزارش کنی 😅"));
    if (!(await userExists(target))) return void (await ctx.reply("کاربر پیدا نشد."));
    const kb = new InlineKeyboard();
    REASONS.forEach((r, i) => kb.text(r.btn, `rr:${i}:${target}`).row());

    await ctx.reply(
      [
        "⚠️ فرم ارسال گزارش عدم رعایت قوانین",
        "",
        `چرا می‌خواهی کاربر <code>${target}</code> را گزارش کنی؟`,
        "",
        `- توجه : ${WARN}`,
        "",
        "انتخاب کن 👇",
      ].join("\n"),
      { ...quoteMsg(ctx), reply_markup: kb }
    );
  });

  bot.callbackQuery(/^rr:(\d):(\d+)$/, async (ctx) => {
    const me = ctx.from.id;
    const reason = REASONS[Number(ctx.match[1])];
    const target = Number(ctx.match[2]);
    if (!reason) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();

    await setReport(me, { target, reason: reason.why });
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(WARN);
    await ctx.reply(
      [
        `⚠️ فرم ارسال گزارش عدم رعایت قوانین به دلیل ${reason.why}`,
        "",
        "<code>خب حالا کافیه یه توضیح دقیق و 《کامل》 درباره گزارشت بفرستی تا ثبتش کنم.</code>",
        "<code>- مثلا: تبلیغ یک کانال یا ایجاد مزاحمت.</code>",
        "",
        `برای لغو گزارش 《 ${REPORT_BACK} 》 را انتخاب کنید 👇`,
      ].join("\n"),
      { ...HTML, reply_markup: new Keyboard().text(REPORT_BACK).resized() }
    );
  });

  // توضیحات گزارش (باید قبل از هندلر متن آزاد ثبت شود)
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return next();
    const uid = ctx.from.id;
    const st = await getReport(uid);
    if (!st) return next();

    if (text === REPORT_BACK) {
      await clearReport(uid);
      return void (await ctx.reply("گزارش لغو شد.", { reply_markup: mainMenu(await isAdminUser(uid)) }));
    }
    const len = [...text].length;
    if (len < 5 || len > 1000) {
      return void (await ctx.reply("⚠️ توضیحات باید بین ۵ تا ۱۰۰۰ کاراکتر باشد. (برای لغو «🔙 بازگشت»)"));
    }

    const res = await createReport({ reporterId: uid, targetId: st.target, reason: st.reason, details: text });
    await clearReport(uid);

    if (res === "duplicate") {
      return void (await ctx.reply("قبلاً درباره‌ی این کاربر گزارشی ثبت کرده‌ای که در حال بررسی است.", {
        reply_markup: mainMenu(await isAdminUser(uid)),
      }));
    }
    await ctx.reply(
      "✅ با تشکر از همکاری شما، گزارش شما با موفقیت ثبت شد و بزودی بررسی خواهد شد 🌹\n\nخب ، حالا چه کاری برات انجام بدم؟",
      {
        reply_parameters: { message_id: ctx.message.message_id },
        reply_markup: mainMenu(await isAdminUser(uid)),
      }
    );
    const owner = ownerId();
    if (owner) {
      await ctx.api
        .sendMessage(owner, "🚨 یک گزارش جدید ثبت شد. منو ← ⚙️ Setting ← 🚨 گزارش‌ها")
        .catch(() => {});
    }
  });

  // ===== ادمین: بخش گزارش‌ها =====

  async function showReport(ctx: Context) {
    const db = getDb();
    const [r] = await db.select().from(reports).where(eq(reports.status, "pending")).orderBy(reports.id).limit(1);
    const [c] = await db.select({ n: count() }).from(reports).where(eq(reports.status, "pending"));
    const back = new InlineKeyboard().text("🔙 برگشت", "menu:settings");
    if (!r) return void (await edit(ctx, "✅ گزارش در انتظار بررسی وجود ندارد.", back));

    const when = r.createdAt.toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
    const text = [
      `🚨 <b>گزارش #${r.id}</b> (${c.n} گزارش در انتظار)`,
      "",
      `👤 گزارش‌دهنده: <code>${r.reporterId}</code>`,
      `🎯 گزارش‌شده: <code>${r.targetId}</code>`,
      `📌 دلیل: ${esc(r.reason)}`,
      `🕒 ${when}`,
      "",
      "📝 توضیحات:",
      `<blockquote>${esc(r.details)}</blockquote>`,
    ].join("\n");

    const kb = new InlineKeyboard()
      .text("✅ تایید تخلف", `rep:ok:${r.id}`)
      .text("⛔️ تایید و مسدودسازی", `rep:ban:${r.id}`)
      .row()
      .text("❌ رد گزارش", `rep:no:${r.id}`)
      .row()
      .text("🔙 برگشت", "menu:settings");
    await edit(ctx, text, kb);
  }

  bot.callbackQuery("admin:reports", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    await ctx.answerCallbackQuery();
    await showReport(ctx);
  });

  bot.callbackQuery(/^rep:(ok|ban|no):(\d+)$/, async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const act = ctx.match[1];
    const id = Number(ctx.match[2]);
    if (act === "ban" && !(await hasAdminPermission(ctx.from.id, "users_manage"))) {
      await ctx.answerCallbackQuery({ text: "برای مسدودسازی کاربر مجوز جداگانه لازم است.", show_alert: true });
      return;
    }
    const db = getDb();
    const [r] = await db.select().from(reports).where(eq(reports.id, id));
    if (!r) return void (await ctx.answerCallbackQuery({ text: "گزارش پیدا نشد" }));

    const status = act === "no" ? "rejected" : "confirmed";
    const upd = await db
      .update(reports)
      .set({ status, reviewedBy: ctx.from.id, reviewedAt: new Date() })
      .where(and(eq(reports.id, id), eq(reports.status, "pending")))
      .returning({ id: reports.id });
    if (upd.length === 0) {
      await ctx.answerCallbackQuery({ text: "این گزارش قبلاً بررسی شده" });
      return void (await showReport(ctx));
    }

    await recordAdminAction(ctx.from.id, `report.${act}`, id, { targetUserId: r.targetId });

    if (status === "confirmed") {
      await addCoins(r.reporterId, COINS.reportReward, "report_reward", `report:${id}`).catch((e) =>
        console.error("report reward error:", e)
      );
      await ctx.api
        .sendMessage(r.reporterId, `✅ گزارش شما تایید شد و ${COINS.reportReward} سکه هدیه گرفتی 🌹`)
        .catch(() => {});
      if (act === "ban") {
        await banUser(r.targetId, `report #${id}`, ctx.from.id);
        await recordAdminAction(ctx.from.id, "user.ban", r.targetId, { reason: `report #${id}` });
      }
    } else {
      await ctx.api
        .sendMessage(r.reporterId, "گزارش شما بررسی شد و تخلفی تایید نشد.")
        .catch(() => {});
    }
    await ctx.answerCallbackQuery({ text: status === "confirmed" ? "✅ تایید شد" : "❌ رد شد" });
    await showReport(ctx);
  });

}
