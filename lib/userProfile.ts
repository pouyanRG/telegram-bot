import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { InlineKeyboard, type Context } from "grammy";
import { getDb } from "./db";
import { users } from "./schema";
import { isUniqueViolation } from "./errors";

const RLM = "\u200F";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const newPublicId = () =>
  Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");

async function ensurePublicId(userId: number, current: string | null) {
  if (current) return current;
  for (let i = 0; i < 5; i++) {
    const id = newPublicId();
    try {
      const rows = await getDb()
        .update(users)
        .set({ publicId: id })
        .where(eq(users.telegramId, userId))
        .returning({ publicId: users.publicId });
      return rows[0]?.publicId ?? id;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new Error("could not allocate publicId");
}

// ترتیب هر ردیف از چپ به راست است (مثل بقیه‌ی کیبوردهای پروژه)
export const profileKb = new InlineKeyboard()
  .text("⚙️ تنظیمات حساب کاربری", "pf:settings")
  .row()
  .text("🖌 تغییر یوزرنیم", "pf:username")
  .text("📝ویرایش پروفایل", "pf:edit")
  .row()
  .text("مشاهده لایک کننده ها ❤️", "pf:likers")
  .row()
  .text("🚫 بلاک لیست ❗️", "pf:blocks")
  .text("👥 گفت و گو های اخیر", "pf:recent")
  .row()
  .text("📌 موقعیت مکانی", "pf:location")
  .text("👫 دوستان", "pf:friends")
  .row()
  .text("❌ دلیت اکانت", "pf:delete");

function buildCaption(
  u: typeof users.$inferSelect,
  publicId: string,
  isSelf: boolean
) {
  const gender = u.gender === "m" ? "پسر 👨" : u.gender === "f" ? "دختر 👩" : "—";
  const name = esc(u.displayName ?? (isSelf ? u.firstName : null) ?? "ناشناس");
  const lines = [
    `${RLM}•نام: ${name}`,
    `${RLM}•جنسیت: ${gender}`,
    `${RLM}دنبال کننده ها: ${u.followersCount}`,
    `${RLM}دنبال میکند: ${u.followingCount}`,
    `${RLM}•استان: ${esc(u.province ?? "—")}`,
    `${RLM}•شهر: ${esc(u.city ?? "—")}`,
    `${RLM}•سن: ${u.age ?? "—"}`,
    `${RLM}🆔 : /user_${publicId}`,
    "",
    `${RLM}تعداد لایک ها : ${u.likesCount}`,
  ];
  if (isSelf) {
    lines.push("", `${RLM}تنظیم حالت سایلنت : /silent`);
  } else {
    const joined = u.createdAt.toLocaleDateString("fa-IR", { timeZone: "Asia/Tehran" });
    lines.push("", `${RLM}📅 تاریخ عضویت: ${joined}`);
  }
  return lines.join("\n");
}

async function pickPhoto(ctx: Context, u: typeof users.$inferSelect, isSelf: boolean) {
  if (u.photoFileId) return u.photoFileId;
  if (!isSelf) return null; // عکس تلگرام فقط برای خودِ کاربر
  try {
    const p = await ctx.api.getUserProfilePhotos(u.telegramId, { limit: 1 });
    const sizes = p.photos[0];
    return sizes?.[sizes.length - 1]?.file_id ?? null;
  } catch {
    return null;
  }
}

/** نمایش پروفایل؛ اگر target همان بیننده باشد دکمه‌های مدیریت هم نمایش داده می‌شود */
export async function sendProfile(ctx: Context, target: typeof users.$inferSelect, viewerId: number) {
  const isSelf = target.telegramId === viewerId;
  const publicId = await ensurePublicId(target.telegramId, target.publicId);
  const caption = buildCaption(target, publicId, isSelf);
  const photo = await pickPhoto(ctx, target, isSelf);
  const opts = {
    parse_mode: "HTML" as const,
    ...(isSelf ? { reply_markup: profileKb } : {}),
  };

  if (photo) {
    try {
      await ctx.replyWithPhoto(photo, { caption, ...opts });
      return;
    } catch (e) {
      console.error("profile photo error:", e instanceof Error ? e.message : "unknown");
    }
  }
  await ctx.reply(caption, opts);
}

export async function getUserRow(userId: number) {
  const [u] = await getDb().select().from(users).where(eq(users.telegramId, userId));
  return u ?? null;
}

export async function getUserByPublicId(publicId: string) {
  const [u] = await getDb().select().from(users).where(eq(users.publicId, publicId));
  return u ?? null;
}

export async function toggleSilent(userId: number) {
  const u = await getUserRow(userId);
  if (!u) return null;
  const next = !u.silent;
  await getDb().update(users).set({ silent: next }).where(eq(users.telegramId, userId));
  return next;
}