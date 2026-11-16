import { eq } from "drizzle-orm";
import type { Context } from "grammy";
import { getDb } from "./db";
import { adminAuditLogs, admins, cache } from "./schema";

export const ADMIN_PERMISSIONS = [
  { key: "dashboard", label: "داشبورد و آمار" },
  { key: "users_view", label: "مشاهده و جستجوی کاربران" },
  { key: "users_manage", label: "مسدودسازی کاربران" },
  { key: "audit_view", label: "گزارش اقدامات ادمین‌ها" },
  { key: "reports_manage", label: "بررسی گزارش‌ها" },
  { key: "sticker_manage", label: "تنظیم استیکر پردازش" },
  { key: "feedback_manage", label: "مدیریت بازخوردها" },
  { key: "maintenance_manage", label: "حالت تعمیرات" },
  { key: "features_manage", label: "فعال/غیرفعال‌کردن قابلیت‌ها" },
  { key: "rate_limit_manage", label: "تنظیم محدودیت نرخ" },
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number]["key"];

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

export async function hasAdminPermission(id: number, permission: AdminPermission) {
  if (isOwner(id)) return true;
  const [row] = await getDb()
    .select({ permissions: admins.permissions })
    .from(admins)
    .where(eq(admins.userId, id));
  return row?.permissions.includes(permission) ?? false;
}

export async function addAdmin(userId: number, addedBy: number) {
  const rows = await getDb()
    .insert(admins)
    .values({ userId, addedBy, permissions: [] })
    .onConflictDoNothing()
    .returning({ userId: admins.userId });
  return rows.length > 0;
}

export async function removeAdmin(userId: number) {
  await getDb().delete(admins).where(eq(admins.userId, userId));
}

export async function listAdmins() {
  return getDb().select().from(admins);
}

export async function getAdminTitle(userId: number) {
  if (isOwner(userId)) return "ادمین اصلی";
  const [row] = await getDb()
    .select({ title: admins.title })
    .from(admins)
    .where(eq(admins.userId, userId));
  return row?.title ?? "ادمین";
}

export async function updateAdmin(
  userId: number,
  patch: { title?: string | null; permissions?: AdminPermission[] }
) {
  await getDb().update(admins).set(patch).where(eq(admins.userId, userId));
}

export async function recordAdminAction(
  actorId: number,
  action: string,
  targetId: number | null = null,
  details: Record<string, unknown> = {}
) {
  await getDb().insert(adminAuditLogs).values({ actorId, action, targetId, details });
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

export async function clearThinkingSticker() {
  await getDb().delete(cache).where(eq(cache.key, STICKER_KEY));
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