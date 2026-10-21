import { eq } from "drizzle-orm";
import { InlineKeyboard, type Bot } from "grammy";
import { getDb } from "./db";
import { cache, users } from "./schema";
import { COINS } from "./config";
import { CITIES, OTHER_CITY } from "./cities";
import { PROVINCES, parseAge } from "./profile";
import { DuplicateRef, spendCoinsTx } from "./coins";
import { getUserRow, sendProfile } from "./userProfile";
import { isAdminUser } from "./admins";
import { clearMode } from "./mode";

// ---------- وضعیت ویرایش (در جدول cache) ----------

type Field = "name" | "age" | "bio" | "photo";
const key = (id: number) => `pedit:${id}`;

async function setEdit(id: number, field: Field) {
  const data = { field };
  await getDb()
    .insert(cache)
    .values({ key: key(id), data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}

async function getEdit(id: number): Promise<Field | null> {
  const [row] = await getDb().select().from(cache).where(eq(cache.key, key(id)));
  const f = (row?.data as { field?: string } | undefined)?.field;
  return f === "name" || f === "age" || f === "bio" || f === "photo" ? f : null;
}

export async function clearEdit(id: number) {
  await getDb().delete(cache).where(eq(cache.key, key(id)));
}

// ---------- اعتبارسنجی ----------

const BAD = /@|https?:|www\.|t\.me|\.(com|ir|org|net|me|io|info)\b/i;
const BIO_MAX = 150;

// کاراکترهای کنترلی و جهت‌دهنده را حذف می‌کند (نیم‌فاصله \u200c می‌ماند)
const clean = (s: string) =>
  s
    .replace(/[\u0000-\u001f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function validateName(raw: string): string | null {
  const s = clean(raw);
  const len = [...s].length;
  if (len < 2 || len > 20 || BAD.test(s)) return null;
  return s;
}

function validateBio(raw: string): string | null {
  const s = clean(raw);
  const len = [...s].length;
  if (len < 1 || len > BIO_MAX || BAD.test(s)) return null;
  return s;
}

// ---------- کیبوردها ----------

const editKb = new InlineKeyboard()
  .text("✏️ نام", "pe:name")
  .text("🎂 سن", "pe:age")
  .row()
  .text("🚻 جنسیت", "pe:gender")
  .text("🗺 استان", "pe:prov")
  .row()
  .text("🏙 شهر", "pe:city")
  .text("🖼 عکس", "pe:photo")
  .row()
  .text("📝 بیو", "pe:bio")
  .row()
  .text("✖️ بستن", "pe:close");

const backKb = new InlineKeyboard().text("⬅️ بازگشت", "pe:menu");

function provinceInlineKb() {
  const kb = new InlineKeyboard();
  PROVINCES.forEach((p, i) => {
    kb.text(p, `pe:prov:${i}`);
    if ((i + 1) % 3 === 0) kb.row();
  });
  return kb.row().text("⬅️ بازگشت", "pe:menu");
}

function cityList(province: string) {
  return [...(CITIES[province] ?? []), OTHER_CITY];
}

function cityInlineKb(province: string) {
  const kb = new InlineKeyboard();
  cityList(province).forEach((c, i) => {
    kb.text(c, `pe:city:${i}`);
    if ((i + 1) % 3 === 0) kb.row();
  });
  return kb.row().text("⬅️ بازگشت", "pe:menu");
}

const MENU_TEXT = "📝 <b>ویرایش پروفایل</b>\nکدام بخش را تغییر بدهم؟";
const HTML = { parse_mode: "HTML" as const };

class NotEnoughCoins extends Error {}

// ---------- ثبت هندلرها ----------

export function registerProfileEdit(bot: Bot) {
  const showProfile = async (ctx: Parameters<typeof sendProfile>[0], uid: number) => {
    const me = await getUserRow(uid);
    if (me) await sendProfile(ctx, me, uid);
  };

  // ورود به منوی ویرایش از دکمه‌ی پروفایل
  bot.callbackQuery("pf:edit", async (ctx) => {
    await ctx.answerCallbackQuery();
    await clearMode(ctx.from.id).catch(() => {});
    await clearEdit(ctx.from.id);
    await ctx.reply(MENU_TEXT, { ...HTML, reply_markup: editKb });
  });

  bot.callbackQuery("pe:menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await clearEdit(ctx.from.id);
    await ctx.editMessageText(MENU_TEXT, { ...HTML, reply_markup: editKb }).catch(() => {});
  });

  bot.callbackQuery("pe:close", async (ctx) => {
    await ctx.answerCallbackQuery();
    await clearEdit(ctx.from.id);
    await ctx.deleteMessage().catch(() => {});
  });

  // --- فیلدهای متنی ---
  const askText = (field: Field, text: string) => async (ctx: any) => {
    await ctx.answerCallbackQuery();
    await setEdit(ctx.from.id, field);
    await ctx.editMessageText(text, { ...HTML, reply_markup: backKb }).catch(() => {});
  };

  bot.callbackQuery(
    "pe:name",
    askText("name", "✏️ نام جدیدت را بفرست.\n<blockquote>۲ تا ۲۰ کاراکتر، بدون لینک و بدون @</blockquote>")
  );
  bot.callbackQuery("pe:age", askText("age", "🎂 سن جدیدت را بفرست (عدد بین ۹ تا ۹۹)."));
  bot.callbackQuery(
    "pe:bio",
    askText(
      "bio",
      `📝 بیوگرافی جدیدت را بفرست.\n<blockquote>حداکثر ${BIO_MAX} کاراکتر، بدون لینک و @\nهزینه: ${COINS.newBio} سکه (فقط بعد از ذخیره‌ی موفق کسر می‌شود)</blockquote>`
    )
  );
  bot.callbackQuery("pe:photo", askText("photo", "🖼 عکس جدیدت را به‌صورت عکس (Photo) بفرست."));

  // --- جنسیت: قفل ---
  bot.callbackQuery("pe:gender", async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "🔒 جنسیت بعد از ثبت قابل تغییر نیست. اگر اشتباه ثبت شده، به پشتیبانی پیام بده.",
      show_alert: true,
    });
  });

  // --- استان ---
  bot.callbackQuery("pe:prov", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("🗺 استان را انتخاب کن:", { reply_markup: provinceInlineKb() }).catch(() => {});
  });

  bot.callbackQuery(/^pe:prov:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const province = PROVINCES[Number(ctx.match[1])];
    if (!province) return;
    // شهر وابسته به استان است؛ با عوض شدن استان باید دوباره انتخاب شود
    await getDb()
      .update(users)
      .set({ province, city: null })
      .where(eq(users.telegramId, ctx.from.id));
    await ctx
      .editMessageText(`✅ استان: ${province}\n\n🏙 حالا شهرت را انتخاب کن:`, {
        reply_markup: cityInlineKb(province),
      })
      .catch(() => {});
  });

  // --- شهر (فقط از لیست استان) ---
  bot.callbackQuery("pe:city", async (ctx) => {
    await ctx.answerCallbackQuery();
    const me = await getUserRow(ctx.from.id);
    if (!me?.province) {
      return void (await ctx
        .editMessageText("اول استان را انتخاب کن:", { reply_markup: provinceInlineKb() })
        .catch(() => {}));
    }
    await ctx
      .editMessageText(`🏙 شهر را انتخاب کن (${me.province}):`, {
        reply_markup: cityInlineKb(me.province),
      })
      .catch(() => {});
  });

  bot.callbackQuery(/^pe:city:(\d+)$/, async (ctx) => {
    const me = await getUserRow(ctx.from.id);
    const city = me?.province ? cityList(me.province)[Number(ctx.match[1])] : undefined;
    if (!city) return void (await ctx.answerCallbackQuery({ text: "نامعتبر" }));

    await getDb().update(users).set({ city }).where(eq(users.telegramId, ctx.from.id));
    await ctx.answerCallbackQuery({ text: "✅ ذخیره شد" });
    await ctx.deleteMessage().catch(() => {});
    await showProfile(ctx, ctx.from.id);
  });

  // --- متن (نام، سن، بیو) ---
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return next();

    const uid = ctx.from.id;
    const field = await getEdit(uid);
    if (!field) return next();

    if (field === "photo") {
      return void (await ctx.reply("🖼 لطفاً یک عکس بفرست، نه متن. (برای خروج /menu)"));
    }

    if (field === "name") {
      const name = validateName(text);
      if (!name) {
        return void (await ctx.reply("⚠️ نام باید ۲ تا ۲۰ کاراکتر باشد و لینک یا @ نداشته باشد."));
      }
      await getDb().update(users).set({ displayName: name }).where(eq(users.telegramId, uid));
    } else if (field === "age") {
      const age = parseAge(text);
      if (age === null) return void (await ctx.reply("⚠️ سن باید عددی بین ۹ تا ۹۹ باشد."));
      await getDb().update(users).set({ age }).where(eq(users.telegramId, uid));
    } else {
      const bio = validateBio(text);
      if (!bio) {
        return void (await ctx.reply(`⚠️ بیو باید ۱ تا ${BIO_MAX} کاراکتر باشد و لینک یا @ نداشته باشد.`));
      }
      const me = await getUserRow(uid);
      if (me?.bio === bio) {
        await clearEdit(uid);
        return void (await ctx.reply("بیو تغییری نکرده؛ سکه‌ای کسر نشد."));
      }
      try {
        // ذخیره‌ی بیو و کسر سکه در یک تراکنش: اگر یکی شکست بخورد هر دو برمی‌گردند
        await getDb().transaction(async (tx) => {
          const left = await spendCoinsTx(
            tx,
            uid,
            COINS.newBio,
            "new_bio",
            `msg:${ctx.message.message_id}`
          );
          if (left === null) throw new NotEnoughCoins();
          await tx.update(users).set({ bio }).where(eq(users.telegramId, uid));
        });
      } catch (e) {
        if (e instanceof DuplicateRef) return; // همان پیام قبلاً پردازش شده
        await clearEdit(uid);
        if (e instanceof NotEnoughCoins) {
          return void (await ctx.reply(`💰 برای ثبت بیو ${COINS.newBio} سکه لازم است و موجودی کافی نیست.`));
        }
        console.error("bio save error:", e instanceof Error ? e.message : "unknown");
        return void (await ctx.reply("⚠️ ذخیره نشد؛ سکه‌ای کسر نشد. دوباره امتحان کن."));
      }
    }

    await clearEdit(uid);
    await ctx.reply("✅ ذخیره شد.");
    await showProfile(ctx, uid);
  });

  // --- عکس ---
  bot.on("message:photo", async (ctx, next) => {
    const uid = ctx.from.id;
    if ((await getEdit(uid)) !== "photo") return next();

    const fileId = ctx.message.photo.at(-1)!.file_id; // بزرگ‌ترین سایز
    await getDb().update(users).set({ photoFileId: fileId }).where(eq(users.telegramId, uid));
    await clearEdit(uid);
    await ctx.reply("✅ عکس ذخیره شد.");
    await showProfile(ctx, uid);
  });

  // --- حذف عکس توسط ادمین ---
  bot.callbackQuery(/^adm:delphoto:(\d+)$/, async (ctx) => {
    if (!(await isAdminUser(ctx.from.id))) {
      return void (await ctx.answerCallbackQuery({ text: "⛔️ فقط ادمین", show_alert: true }));
    }
    await getDb()
      .update(users)
      .set({ photoFileId: null })
      .where(eq(users.telegramId, Number(ctx.match[1])));
    await ctx.answerCallbackQuery({ text: "🗑 عکس حذف شد" });
    await ctx.deleteMessage().catch(() => {});
  });
}