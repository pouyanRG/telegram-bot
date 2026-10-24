import { and, count, eq } from "drizzle-orm";
import { InlineKeyboard, Keyboard, type Bot, type Context } from "grammy";
import { getDb } from "./db";
import { bans, cache, reports, users } from "./schema";
import { COINS } from "./config";
import { addCoins } from "./coins";
import { findLastChatBetween, getAnon, snapshotChat } from "./anon";
import { isAdminUser, ownerId } from "./admins";
import { ensurePublicId, getUserRow } from "./userProfile";
import { idleKb } from "./menu";
import { likeProfile } from "./likes";
import { peerKb } from "./peerProfile";
import { setDefaultPhoto, getDefaultPhoto, setPendingDefPhoto, takePendingDefPhoto, type G } from "./defaultPhoto";

const HTML = { parse_mode: "HTML" as const };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const REPORT_BACK = "🔙 بازگشت";

const REASONS = [
  { btn: "تبلیغات سایت ها و ربات ها و کانال ها", why: "تبلیغات سایت‌ها و ربات‌ها و کانال‌ها" },
  { btn: "ارسال محتوای غیراخلاقی در چت", why: "ارسال محتوای غیراخلاقی در چت" },
  { btn: "ایجاد مزاحمت", why: "ایجاد مزاحمت" },
  { btn: "پخش شماره موبایل یا اطلاعات شخصی دیگران", why: "پخش شماره موبایل یا اطلاعات شخصی دیگران" },
  { btn: "کلمات یا عکس غیر اخلاقی و یا توهین آمیز در پروفایل", why: "کلمات یا عکس غیر اخلاقی و یا توهین آمیز در پروفایل" },
  { btn: "جنسیت اشتباه در پروفایل", why: "جنسیت اشتباه در پروفایل" },
  { btn: "دیگر موارد...", why: "دیگر موارد" },
];

const CHATTING_ERR =
  "⚠️ خطا : هم اکنون شما در حال چت هستید !\n\n<code>برای استفاده از ربات ابتدا باید مکالمه رو قطع کنی 👇</code>";

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
export { takePendingDefPhoto };

// ---------- کمکی‌ها ----------

async function publicIdOf(userId: number) {
  const u = await getUserRow(userId);
  return u ? ensurePublicId(userId, u.publicId) : String(userId);
}

async function adminOnly(ctx: Context) {
  if (ctx.from && (await isAdminUser(ctx.from.id))) return true;
  await ctx.answerCallbackQuery({ text: "⛔️ فقط ادمین", show_alert: true }).catch(() => {});
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

async function banUser(id: number, reason: string) {
  await getDb().transaction(async (tx) => {
    await tx.update(users).set({ isBanned: true }).where(eq(users.telegramId, id));
    const [open] = await tx
      .select({ id: bans.id })
      .from(bans)
      .where(and(eq(bans.userId, id), eq(bans.unbannedAt, null as never)))
      .limit(1)
      .catch(() => [undefined] as const);
    if (!open) await tx.insert(bans).values({ userId: id, reason });
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

  const chat = await findLastChatBetween(p.reporterId, p.targetId);
  const evidence = chat ? await snapshotChat(chat.id, p.reporterId) : null;
  await db.insert(reports).values({ ...p, chatId: chat?.id ?? null, evidence });
  return "ok" as const;
}

// ---------- ثبت هندلرها ----------

export function registerReports(bot: Bot) {
  // ===== پروفایل مخاطب: لایک =====
  bot.callbackQuery(/^pp:like:(\d+)$/, async (ctx) => {
    const target = Number(ctx.match[1]);
    const r = await likeProfile(ctx.from.id, target);
    if (r.status === "self") {
      return void (await ctx.answerCallbackQuery({ text: "پروفایل خودت را نمی‌توانی لایک کنی 😅" }));
    }
    if (r.status === "missing") return void (await ctx.answerCallbackQuery({ text: "کاربر پیدا نشد" }));
    if (r.status === "already") {
      return void (await ctx.answerCallbackQuery({ text: "❤️ قبلاً این کاربر را لایک کرده‌ای" }));
    }
    const t = await getUserRow(target);
    const adm = await isAdminUser(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "❤️ لایک شد" });
    await ctx
      .editMessageReplyMarkup({ reply_markup: peerKb(target, r.likes, adm && !!t?.photoFileId) })
      .catch(() => {});
  });

  // دکمه‌های بدون عملکرد هنوز
  bot.callbackQuery(/^pp:(gift|dm|chat|block|add|notify):\d+$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "این بخش به‌زودی فعال می‌شود 🚧" });
  });

  // ===== گزارش کاربر =====
  bot.callbackQuery(/^rp:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const me = ctx.from.id;
    const target = Number(ctx.match[1]);

    if ((await getAnon(me))?.state === "chatting") {
      return void (await ctx.reply(CHATTING_ERR, { ...HTML, ...quoteMsg(ctx) }));
    }
    if (target === me) return void (await ctx.reply("خودت را نمی‌توانی گزارش کنی 😅"));
    const t = await getUserRow(target);
    if (!t) return void (await ctx.reply("کاربر پیدا نشد."));

    const pid = await publicIdOf(target);
    const kb = new InlineKeyboard();
    REASONS.forEach((r, i) => kb.text(r.btn, `rr:${i}:${target}`).row());

    await ctx.reply(
      [
        "⚠️ فرم ارسال گزارش عدم رعایت قوانین",
        "",
        `چرا میخوای /user_${pid} رو گزارش کنی؟`,
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

    if ((await getAnon(me))?.state === "chatting") {
      return void (await ctx.reply(CHATTING_ERR, HTML));
    }

    await setReport(me, { target, reason: reason.why });
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(WARN);
    await ctx.reply(
      [
        `⚠️ فرم ارسال گزارش عدم رعایت قوانین به دلیل ${reason.why}`,
        "",
        "<code>خب حالا کافیه یه توضیح دقیق و 《کامل》 درباره گزارشت بفرستی تا ثبتش کنم.</code>",
        "<code>- مثلا : داره تبلیغات فلان کانال رو توی چت ( یا پروفایلش ) میکنه.</code>",
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
      return void (await ctx.reply("گزارش لغو شد.", { reply_markup: idleKb }));
    }
    const len = [...text].length;
    if (len < 5 || len > 1000) {
      return void (await ctx.reply("⚠️ توضیحات باید بین ۵ تا ۱۰۰۰ کاراکتر باشد. (برای لغو «🔙 بازگشت»)"));
    }

    const res = await createReport({ reporterId: uid, targetId: st.target, reason: st.reason, details: text });
    await clearReport(uid);

    if (res === "duplicate") {
      return void (await ctx.reply("قبلاً درباره‌ی این کاربر گزارشی ثبت کرده‌ای که در حال بررسی است.", {
        reply_markup: idleKb,
      }));
    }
    await ctx.reply(
      "✅ با تشکر از همکاری شما، گزارش شما با موفقیت ثبت شد و بزودی بررسی خواهد شد 🌹\n\nخب ، حالا چه کاری برات انجام بدم؟",
      { reply_parameters: { message_id: ctx.message.message_id }, reply_markup: idleKb }
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

    const [rp, tp] = await Promise.all([publicIdOf(r.reporterId), publicIdOf(r.targetId)]);
    const when = r.createdAt.toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
    const text = [
      `🚨 <b>گزارش #${r.id}</b> (${c.n} گزارش در انتظار)`,
      "",
      `👤 گزارش‌دهنده: /user_${rp} (<code>${r.reporterId}</code>)`,
      `🎯 گزارش‌شده: /user_${tp} (<code>${r.targetId}</code>)`,
      `📌 دلیل: ${esc(r.reason)}`,
      `🕒 ${when}`,
      "",
      "📝 توضیحات:",
      `<blockquote>${esc(r.details)}</blockquote>`,
    ].join("\n");

    const kb = new InlineKeyboard()
      .text("👁 مشاهده چت", `rep:chat:${r.id}`)
      .row()
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

  async function sendEvidence(ctx: Context, r: typeof reports.$inferSelect) {
    const ev = (r.evidence as { m: number; f: number | null }[] | null) ?? [];
    if (ev.length === 0) {
      return void (await ctx.reply("چتی برای این گزارش ذخیره نشده (گزارش از طریق پروفایل بوده یا چت قدیمی است)."));
    }
    // پیام‌های پشت‌سرهم از یک فرستنده، یک دسته
    const runs: { who: "r" | "t" | "?"; ids: number[] }[] = [];
    for (const e of ev) {
      const who = e.f === r.reporterId ? "r" : e.f === r.targetId ? "t" : "?";
      const last = runs[runs.length - 1];
      if (last && last.who === who && last.ids.length < 100) last.ids.push(e.m);
      else runs.push({ who, ids: [e.m] });
    }
    await ctx.reply("🗂 چت گزارش (۱۵۰ پیام آخر؛ پیام‌هایی که حذف شده باشند نمایش داده نمی‌شوند):");
    for (const run of runs) {
      const label = run.who === "r" ? "👤 گزارش‌دهنده:" : run.who === "t" ? "🚨 گزارش‌شده:" : "❔ نامشخص:";
      await ctx.reply(label);
      await ctx.api.copyMessages(ctx.chat!.id, r.reporterId, run.ids).catch((e) =>
        console.error("evidence copy error:", e instanceof Error ? e.message : "unknown")
      );
    }
  }

  bot.callbackQuery(/^rep:(chat|ok|ban|no):(\d+)$/, async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const act = ctx.match[1];
    const id = Number(ctx.match[2]);
    const db = getDb();
    const [r] = await db.select().from(reports).where(eq(reports.id, id));
    if (!r) return void (await ctx.answerCallbackQuery({ text: "گزارش پیدا نشد" }));

    if (act === "chat") {
      await ctx.answerCallbackQuery({ text: "در حال ارسال…" });
      return void (await sendEvidence(ctx, r));
    }

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

    if (status === "confirmed") {
      await addCoins(r.reporterId, COINS.reportReward, "report_reward", `report:${id}`).catch((e) =>
        console.error("report reward error:", e)
      );
      await ctx.api
        .sendMessage(r.reporterId, `✅ گزارش شما تایید شد و ${COINS.reportReward} سکه هدیه گرفتی 🌹`)
        .catch(() => {});
      if (act === "ban") await banUser(r.targetId, `report #${id}`);
    } else {
      await ctx.api
        .sendMessage(r.reporterId, "گزارش شما بررسی شد و تخلفی تایید نشد.")
        .catch(() => {});
    }
    await ctx.answerCallbackQuery({ text: status === "confirmed" ? "✅ تایید شد" : "❌ رد شد" });
    await showReport(ctx);
  });

  // ===== ادمین: عکس پیش‌فرض =====

  bot.callbackQuery(/^admin:defphoto:(m|f)$/, async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    await ctx.answerCallbackQuery();
    const g = ctx.match[1] as G;
    await setPendingDefPhoto(ctx.from.id, g);

    const cur = await getDefaultPhoto(g).catch(() => null);
    const name = g === "m" ? "پسرونه" : "دخترونه";
    if (cur) {
      await ctx.reply(`عکس فعلی پیش‌فرض ${name}:`);
      await ctx.replyWithPhoto(cur).catch(() => {});
    }
    await ctx.reply(`🖼 عکس پیش‌فرض ${name} را به‌صورت عکس (Photo) بفرست.`, {
      reply_markup: new InlineKeyboard().text("❌ انصراف", "admin:defphoto_cancel"),
    });
  });

  bot.callbackQuery("admin:defphoto_cancel", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    await takePendingDefPhoto(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "لغو شد" });
    await ctx.deleteMessage().catch(() => {});
  });

  bot.on("message:photo", async (ctx, next) => {
    const uid = ctx.from.id;
    if (!(await isAdminUser(uid))) return next();
    const g = await takePendingDefPhoto(uid);
    if (!g) return next();
    await setDefaultPhoto(g, ctx.message.photo.at(-1)!.file_id);
    await ctx.reply(`✅ عکس پیش‌فرض ${g === "m" ? "پسرونه" : "دخترونه"} ذخیره شد.`, {
      reply_markup: new InlineKeyboard().text("🔙 برگشت", "menu:settings"),
    });
  });
}