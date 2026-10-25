import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { InlineKeyboard, Keyboard, type Bot, type CommandContext, type Context } from "grammy";
import { getDb } from "./db";
import { anonDirect, cache, users } from "./schema";
import { isUniqueViolation } from "./errors";
import { getAnon } from "./anon";
import { idleKb } from "./menu";

const HTML = { parse_mode: "HTML" as const };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const DM_BACK = "بازگشت";
const backKb = new Keyboard().text(DM_BACK).resized().persistent();
const footer = (code: string) => `\n\n__________\n#${code}`;
const MAX_TEXT = 3000;
const MAX_CAPTION = 800;

const LINK_TEXT =
  "لینک زیر رو لمس کن و هر حرفی که تو دلت هست یا هر انتقادی که نسبت به من داری رو با خیال راحت بنویس و بفرست. بدون اینکه از اسمت باخبر بشم پیامت به من می‌رسه. خودتم می‌تونی امتحان کنی و از بقیه بخوای راحت و ناشناس بهت پیام بفرستن، حرفای خیلی جالبی می‌شنوی! 😉";

const SELF_TEXT =
  "اینکه آدم گاهی با خودش حرف بزنه خوبه ، ولی اینجا نمیتونی به خودت پیام ناشناس بفرستی ! :)\n\nچه کاری برات انجام بدم؟";

const promptText = (name: string) =>
  `در حال ارسال پیام ناشناس به ${name} هستی\n\nمی‌تونی هر حرف یا انتقادی که تو دلت هست رو بگی چون پیامت به صورت کاملا ناشناس ارسال می‌شه!`;

// ---------- کد لینک ناشناس: sc- + ۸ حرف (بزرگ/کوچک/عدد) ----------

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const newLinkCode = () =>
  "sc-" + Array.from(randomBytes(8), (b) => ALPHA[b % ALPHA.length]).join("");

const MSG_ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";
const newMsgCode = () =>
  Array.from(randomBytes(6), (b) => MSG_ALPHA[b % MSG_ALPHA.length]).join("");

export async function ensureAnonCode(userId: number): Promise<string> {
  const db = getDb();
  const read = async () =>
    (await db.select({ c: users.anonCode }).from(users).where(eq(users.telegramId, userId)))[0]?.c ?? null;

  const cur = await read();
  if (cur) return cur;
  for (let i = 0; i < 5; i++) {
    try {
      const rows = await db
        .update(users)
        .set({ anonCode: newLinkCode() })
        .where(and(eq(users.telegramId, userId), isNull(users.anonCode)))
        .returning({ c: users.anonCode });
      if (rows[0]?.c) return rows[0].c;
      const again = await read();
      if (again) return again;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new Error("could not allocate anon code");
}

// ---------- وضعیت «در حال نوشتن پیام ناشناس» (جدول cache) ----------

type DmState = { to: number; replyTo?: number };
const key = (id: number) => `dm:${id}`;

async function setDmState(id: number, data: DmState) {
  await getDb()
    .insert(cache)
    .values({ key: key(id), data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}

async function getDmState(id: number) {
  const [row] = await getDb().select().from(cache).where(eq(cache.key, key(id)));
  return (row?.data as DmState | undefined) ?? null;
}

export async function clearDmState(id: number) {
  await getDb().delete(cache).where(eq(cache.key, key(id)));
}

// ---------- دکمه‌ی «لینک ناشناس من» ----------

export async function sendMyLink(ctx: Context) {
  const code = await ensureAnonCode(ctx.from!.id);
  const link = `https://t.me/${ctx.me.username}?start=${code}`;
  await ctx.reply(`${LINK_TEXT}\n\n${link}`, { link_preview_options: { is_disabled: true } });
}

// ---------- /start sc-xxxxxxxx ----------

/** اگر payload لینک ناشناس بود پردازش می‌کند و true برمی‌گرداند */
export async function handleStartPayload(ctx: CommandContext<Context>) {
  const payload = (ctx.match ?? "").trim();
  if (!/^sc-[A-Za-z0-9]{8}$/.test(payload)) return false;

  const me = ctx.from!.id;
  if ((await getAnon(me))?.state === "chatting") {
    await ctx.reply("الان وسط چت هستی. اول چت را تمام کن.");
    return true;
  }

  const [t] = await getDb().select().from(users).where(eq(users.anonCode, payload));
  if (!t) {
    await ctx.reply("این لینک معتبر نیست.");
    return true;
  }
  if (t.telegramId === me) {
    await ctx.reply(SELF_TEXT, { reply_markup: idleKb });
    return true;
  }

  await setDmState(me, { to: t.telegramId });
  await ctx.reply(promptText(esc(t.displayName ?? t.firstName ?? "ناشناس")), {
    ...HTML,
    reply_markup: backKb,
  });
  return true;
}

// ---------- هندلرها ----------

export function registerAnonLink(bot: Bot) {
  // دریافت پیام کاربر در حالت «نوشتن پیام ناشناس»
  bot.on("message", async (ctx, next) => {
    const msg = ctx.message;
    if (msg.text?.startsWith("/")) return next();
    const uid = ctx.from.id;
    const st = await getDmState(uid);
    if (!st) return next();

    if (msg.text === DM_BACK) {
      await clearDmState(uid);
      return void (await ctx.reply(
        "خب ، حالا چه کاری برات انجام بدم؟\n<code>از منوی پایین👇 انتخاب کن</code>",
        { ...HTML, reply_markup: idleKb }
      ));
    }

    let kind: "text" | "media";
    let body: string | null = null;
    if (msg.text) {
      kind = "text";
      body = msg.text;
    } else if (
      msg.photo || msg.video || msg.voice || msg.audio || msg.animation ||
      msg.document || msg.sticker || msg.video_note
    ) {
      kind = "media";
      body = msg.caption ?? null;
    } else {
      return void (await ctx.reply("⚠️ این نوع پیام پشتیبانی نمی‌شود."));
    }
    if (body && [...body].length > (kind === "text" ? MAX_TEXT : MAX_CAPTION)) {
      return void (await ctx.reply("⚠️ پیامت خیلی طولانی است. کوتاه‌ترش کن."));
    }

    const db = getDb();
    const [target] = await db.select().from(users).where(eq(users.telegramId, st.to));
    if (!target) {
      await clearDmState(uid);
      return void (await ctx.reply("کاربر پیدا نشد.", { reply_markup: idleKb }));
    }

    let row: { id: number } | undefined;
    for (let i = 0; i < 5 && !row; i++) {
      try {
        [row] = await db
          .insert(anonDirect)
          .values({
            code: newMsgCode(), fromId: uid, toId: st.to, kind, body,
            srcMsgId: msg.message_id, replyTo: st.replyTo ?? null,
          })
          .returning({ id: anonDirect.id });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    }
    if (!row) throw new Error("could not allocate message code");

    try {
      await ctx.api.sendMessage(st.to, "شما یک پیام ناشناس جدید دارید", {
        disable_notification: target.silent,
        reply_markup: new InlineKeyboard().text("مشاهده پیام", `dm:v:${row.id}`),
      });
    } catch {
      await db.delete(anonDirect).where(eq(anonDirect.id, row.id));
      await clearDmState(uid);
      return void (await ctx.reply("⚠️ ارسال نشد؛ این کاربر در دسترس نیست.", { reply_markup: idleKb }));
    }

    await clearDmState(uid);
    await ctx.reply("پیام شما ارسال شد!", {
      reply_parameters: { message_id: msg.message_id },
      reply_markup: idleKb,
    });
  });

  // «مشاهده پیام»
  bot.callbackQuery(/^dm:v:(\d+)$/, async (ctx) => {
    const [row] = await getDb().select().from(anonDirect).where(eq(anonDirect.id, Number(ctx.match[1])));
    if (!row || row.toId !== ctx.from.id) {
      return void (await ctx.answerCallbackQuery({ text: "پیام پیدا نشد" }));
    }
    await ctx.answerCallbackQuery();

    const kb = new InlineKeyboard().text("ارسال پاسخ", `dm:r:${row.id}`);
    if (row.kind === "text") {
      return void (await ctx.reply((row.body ?? "") + footer(row.code), { reply_markup: kb }));
    }

    const chatId = ctx.chat!.id;
    try {
      await ctx.api.copyMessage(chatId, row.fromId, row.srcMsgId, {
        caption: (row.body ?? "") + footer(row.code),
        reply_markup: kb,
      });
    } catch {
      try {
        // استیکر و ویدیو‌مسیج کپشن ندارند
        await ctx.api.copyMessage(chatId, row.fromId, row.srcMsgId, { reply_markup: kb });
        await ctx.reply(footer(row.code).trim());
      } catch {
        await ctx.reply("⚠️ این پیام دیگر در دسترس نیست.");
      }
    }
  });

  // «ارسال پاسخ»
  bot.callbackQuery(/^dm:r:(\d+)$/, async (ctx) => {
    const [row] = await getDb().select().from(anonDirect).where(eq(anonDirect.id, Number(ctx.match[1])));
    if (!row || row.toId !== ctx.from.id) {
      return void (await ctx.answerCallbackQuery({ text: "پیام پیدا نشد" }));
    }
    await ctx.answerCallbackQuery();
    await setDmState(ctx.from.id, { to: row.fromId, replyTo: row.id });
    await ctx.reply(promptText(""), { reply_markup: backKb });
  });
}