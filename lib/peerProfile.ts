import type { Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { getAnon } from "./anon";
import { getDefaultPhoto } from "./defaultPhoto";
import type { users } from "./schema";
import { ensurePublicId, sendProfile } from "./userProfile";

const RLM = "\u200F";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ONLINE_MS = 6 * 60_000; // lastSeenAt هر ۵ دقیقه یک بار نوشته می‌شود

// ترتیب هر ردیف از چپ به راست
export function peerKb(targetId: number, likes: number, adminDelPhoto = false): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [{ text: `Like ❤️ ${likes}`, callback_data: `pp:like:${targetId}` }],
    [{ text: "🎁 خرید سکه برای این کاربر", callback_data: `pp:gift:${targetId}` }],
    [
      { text: "💌 پیام دایرکت", callback_data: `pp:dm:${targetId}`, style: "success" },
      { text: "🗳 درخواست چت", callback_data: `pp:chat:${targetId}`, style: "success" },
    ],
    [
      { text: "🔓 بلاک کردن کاربر", callback_data: `pp:block:${targetId}` },
      { text: "➕ افزودن به مخاطبین", callback_data: `pp:add:${targetId}` },
    ],
    [{ text: "🚫 گزارش کاربر", callback_data: `rp:${targetId}`, style: "danger" }],
    [{ text: "🔔 به محض اتمام چت اطلاع بده", callback_data: `pp:notify:${targetId}` }],
  ];
  if (adminDelPhoto) {
    rows.push([{ text: "🗑 حذف عکس (ادمین)", callback_data: `adm:delphoto:${targetId}` }]);
  }
  return { inline_keyboard: rows };
}

export async function sendPeerProfile(
  ctx: Context,
  target: typeof users.$inferSelect,
  viewerId: number,
  viewerIsAdmin = false
) {
  if (target.telegramId === viewerId) return sendProfile(ctx, target, viewerId);

  const publicId = await ensurePublicId(target.telegramId, target.publicId);
  const a = await getAnon(target.telegramId).catch(() => null);
  const online = Date.now() - target.lastSeenAt.getTime() < ONLINE_MS;

  const status =
    a?.state === "chatting"
      ? "هم اکنون 👀 آنلایــن ( 🗣 درحال‌چت)"
      : online
        ? "هم اکنون 👀 آنلایــن"
        : `آخرین بازدید: ${target.lastSeenAt.toLocaleDateString("fa-IR", { timeZone: "Asia/Tehran" })}`;

  const gender = target.gender === "m" ? "پسر 👨‍🦱" : target.gender === "f" ? "دختر 👩" : "—";
  const caption = [
    `${RLM}• نام: ${esc(target.displayName ?? "ناشناس")}`,
    `${RLM}• سن: ${target.age ?? "—"}`,
    `${RLM}• جنسیت: ${gender}`,
    `${RLM}• استان: ${esc(target.province ?? "—")}`,
    `${RLM}• شهر: ${esc(target.city ?? "—")}`,
    "",
    `${RLM}📝 بیوگرافی: ${target.bio ? esc(target.bio) : "❓"}`,
    "",
    `${RLM}${status}`,
    "",
    `${RLM}🆔 آیدی : /user_${publicId}`,
  ].join("\n");

  const reply_markup = peerKb(target.telegramId, target.likesCount, viewerIsAdmin && !!target.photoFileId);
  const photo = target.photoFileId ?? (await getDefaultPhoto(target.gender).catch(() => null));

  if (photo) {
    try {
      await ctx.replyWithPhoto(photo, { caption, parse_mode: "HTML", reply_markup });
      return;
    } catch (e) {
      console.error("peer photo error:", e instanceof Error ? e.message : "unknown");
    }
  }
  await ctx.reply(caption, { parse_mode: "HTML", reply_markup });
}