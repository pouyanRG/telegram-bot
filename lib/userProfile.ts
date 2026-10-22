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

export async function ensurePublicId(userId: number, current: string | null) {
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

// ØªØ±ØªÛŒØ¨ Ù‡Ø± Ø±Ø¯ÛŒÙ Ø§Ø² Ú†Ù¾ Ø¨Ù‡ Ø±Ø§Ø³Øª Ø§Ø³Øª (Ù…Ø«Ù„ Ø¨Ù‚ÛŒÙ‡â€ŒÛŒ Ú©ÛŒØ¨ÙˆØ±Ø¯Ù‡Ø§ÛŒ Ù¾Ø±ÙˆÚ˜Ù‡)
export const profileKb = new InlineKeyboard()
  .text("âš™ï¸ ØªÙ†Ø¸ÛŒÙ…Ø§Øª Ø­Ø³Ø§Ø¨ Ú©Ø§Ø±Ø¨Ø±ÛŒ", "pf:settings")
  .row()
  .text("ðŸ–Œ ØªØºÛŒÛŒØ± ÛŒÙˆØ²Ø±Ù†ÛŒÙ…", "pf:username")
  .text("ðŸ“ÙˆÛŒØ±Ø§ÛŒØ´ Ù¾Ø±ÙˆÙØ§ÛŒÙ„", "pf:edit")
  .row()
  .text("Ù…Ø´Ø§Ù‡Ø¯Ù‡ Ù„Ø§ÛŒÚ© Ú©Ù†Ù†Ø¯Ù‡ Ù‡Ø§ â¤ï¸", "pf:likers")
  .row()
  .text("ðŸš« Ø¨Ù„Ø§Ú© Ù„ÛŒØ³Øª â—ï¸", "pf:blocks")
  .text("ðŸ‘¥ Ú¯ÙØª Ùˆ Ú¯Ùˆ Ù‡Ø§ÛŒ Ø§Ø®ÛŒØ±", "pf:recent")
  .row()
  .text("ðŸ“Œ Ù…ÙˆÙ‚Ø¹ÛŒØª Ù…Ú©Ø§Ù†ÛŒ", "pf:location")
  .text("ðŸ‘« Ø¯ÙˆØ³ØªØ§Ù†", "pf:friends")
  .row()
  .text("âŒ Ø¯Ù„ÛŒØª Ø§Ú©Ø§Ù†Øª", "pf:delete");

function buildCaption(
  u: typeof users.$inferSelect,
  publicId: string,
  isSelf: boolean
) {
  const gender = u.gender === "m" ? "Ù¾Ø³Ø± ðŸ‘¨" : u.gender === "f" ? "Ø¯Ø®ØªØ± ðŸ‘©" : "â€”";
  const name = esc(u.displayName ?? (isSelf ? u.firstName : null) ?? "Ù†Ø§Ø´Ù†Ø§Ø³");
  const lines = [
    `${RLM}â€¢Ù†Ø§Ù…: ${name}`,
    `${RLM}â€¢Ø¬Ù†Ø³ÛŒØª: ${gender}`,
    `${RLM}Ø¯Ù†Ø¨Ø§Ù„ Ú©Ù†Ù†Ø¯Ù‡ Ù‡Ø§: ${u.followersCount}`,
    `${RLM}Ø¯Ù†Ø¨Ø§Ù„ Ù…ÛŒÚ©Ù†Ø¯: ${u.followingCount}`,
    `${RLM}â€¢Ø§Ø³ØªØ§Ù†: ${esc(u.province ?? "â€”")}`,
    `${RLM}â€¢Ø´Ù‡Ø±: ${esc(u.city ?? "â€”")}`,
    `${RLM}â€¢Ø³Ù†: ${u.age ?? "â€”"}`,
    `${RLM}ðŸ†” : /user_${publicId}`,
    "",
    `${RLM}ØªØ¹Ø¯Ø§Ø¯ Ù„Ø§ÛŒÚ© Ù‡Ø§ : ${u.likesCount}`,
  ];
  if (u.bio) lines.push("", `${RLM}ðŸ“ ${esc(u.bio)}`);
  if (isSelf) {
    lines.push("", `${RLM}ØªÙ†Ø¸ÛŒÙ… Ø­Ø§Ù„Øª Ø³Ø§ÛŒÙ„Ù†Øª : /silent`);
  } else {
    const joined = u.createdAt.toLocaleDateString("fa-IR", { timeZone: "Asia/Tehran" });
    lines.push("", `${RLM}ðŸ“… ØªØ§Ø±ÛŒØ® Ø¹Ø¶ÙˆÛŒØª: ${joined}`);
  }
  return lines.join("\n");
}

async function pickPhoto(ctx: Context, u: typeof users.$inferSelect, isSelf: boolean) {
  if (u.photoFileId) return u.photoFileId;
  if (!isSelf) return null; // Ø¹Ú©Ø³ ØªÙ„Ú¯Ø±Ø§Ù… ÙÙ‚Ø· Ø¨Ø±Ø§ÛŒ Ø®ÙˆØ¯Ù Ú©Ø§Ø±Ø¨Ø±
  try {
    const p = await ctx.api.getUserProfilePhotos(u.telegramId, { limit: 1 });
    const sizes = p.photos[0];
    return sizes?.[sizes.length - 1]?.file_id ?? null;
  } catch {
    return null;
  }
}

/** Ù†Ù…Ø§ÛŒØ´ Ù¾Ø±ÙˆÙØ§ÛŒÙ„Ø› Ø§Ú¯Ø± target Ù‡Ù…Ø§Ù† Ø¨ÛŒÙ†Ù†Ø¯Ù‡ Ø¨Ø§Ø´Ø¯ Ø¯Ú©Ù…Ù‡â€ŒÙ‡Ø§ÛŒ Ù…Ø¯ÛŒØ±ÛŒØª Ù‡Ù… Ù†Ù…Ø§ÛŒØ´ Ø¯Ø§Ø¯Ù‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯ */
export async function sendProfile(
  ctx: Context,
  target: typeof users.$inferSelect,
  viewerId: number,
  viewerIsAdmin = false
) {
  const isSelf = target.telegramId === viewerId;
  const publicId = await ensurePublicId(target.telegramId, target.publicId);
  const caption = buildCaption(target, publicId, isSelf);
  const photo = await pickPhoto(ctx, target, isSelf);

  const adminKb =
    viewerIsAdmin && !isSelf && target.photoFileId
      ? new InlineKeyboard().text("ðŸ—‘ Ø­Ø°Ù Ø¹Ú©Ø³", `adm:delphoto:${target.telegramId}`)
      : undefined;

  const opts = {
    parse_mode: "HTML" as const,
    ...(isSelf ? { reply_markup: profileKb } : adminKb ? { reply_markup: adminKb } : {}),
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
