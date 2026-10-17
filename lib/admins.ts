import { eq } from "drizzle-orm";
import type { Context } from "grammy";
import { getDb } from "./db";
import { admins, cache } from "./schema";

// ---------- نقش‌ها ----------

export function ownerId(): number | null {
  const n = Number(process.env.OWNER_ID);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const isOwner = (id: number) => ownerId() === id;

export async function isAdminUser(id: number) {
  if (isOwner(id)) return true;
  const [r] = await getDb().select().from(admins).where(eq(admins.userId, id));
  return !!r;
}

export async function addAdmin(userId: number, addedBy: number) {
  await getDb().insert(admins).values({ userId, addedBy }).onConflictDoNothing();
}

export async function removeAdmin(userId: number) {
  await getDb().delete(admins).where(eq(admins.userId, userId));
}

export async function listAdmins() {
  return getDb().select().from(admins);
}

// ---------- استیکر فکرکردن ----------

const STICKER_KEY = "thinking_sticker";

// اگر استیکری تنظیم نباشد (یا ارسالش خطا بدهد) این ایموجی فرستاده می‌شود
const FALLBACK_THINKING = "🔎";

export async function getThinkingSticker(): Promise<string | null> {
  const [row] = await getDb().select().from(cache).where(eq(cache.key, STICKER_KEY));
  return (row?.data as { fileId?: string } | undefined)?.fileId ?? null;
}

export async function setThinkingSticker(fileId: string) {
  const data = { fileId };
  await getDb()
    .insert(cache)
    .values({ key: STICKER_KEY, data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}

/** ارسال استیکر (یا 🔎)، اجرای کار، و حذف پیام بعد از پایان (چه موفق چه خطا) */
export async function withThinking<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
  let thinkingMsgId: number | undefined;
  try {
    const fileId = await getThinkingSticker();
    let sent: { message_id: number } | null = null;
    if (fileId) sent = await ctx.replyWithSticker(fileId).catch(() => null);
    if (!sent) sent = await ctx.reply(FALLBACK_THINKING);
    thinkingMsgId = sent.message_id;
  } catch (e) {
    console.error("thinking message error:", e); // خطای اینجا نباید کار اصلی را خراب کند
  }
  try {
    return await fn();
  } finally {
    if (thinkingMsgId && ctx.chat) {
      await ctx.api.deleteMessage(ctx.chat.id, thinkingMsgId).catch(() => {});
    }
  }
}

// ---------- حالت «منتظر استیکر» (چون سرورلس است، در دیتابیس) ----------
// بدون تاریخ انقضا: تا وقتی ادمین استیکر بفرستد یا انصراف/برگشت بزند فعال می‌ماند.

const pendingKey = (id: number) => `pending_sticker:${id}`;

export async function setPendingSticker(userId: number) {
  const data = { at: Date.now() };
  await getDb()
    .insert(cache)
    .values({ key: pendingKey(userId), data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}

/** اگر در انتظار استیکر بود، true برمی‌گرداند و حالت را پاک می‌کند */
export async function takePendingSticker(userId: number) {
  const rows = await getDb()
    .delete(cache)
    .where(eq(cache.key, pendingKey(userId)))
    .returning({ key: cache.key });
  return rows.length > 0;
}