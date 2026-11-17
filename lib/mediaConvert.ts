import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";
import { getDb } from "./db";
import { logOperationalError } from "./operationalErrors";
import { downloadTelegramFile } from "./telegramFile";
import { UserError } from "./errors";
import { clearMode, getMode, setMediaMode } from "./mode";
import { cache } from "./schema";
import {
  convertMedia,
  conversionExtension,
  MAX_OUTPUT_BYTES,
  MAX_STICKER_BYTES,
  type ConversionKind,
} from "./convert";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const CONVERSION_TTL_MS = 10 * 60 * 1000;

type ConversionAction = {
  kind: ConversionKind;
  label: string;
  message: string;
  pack?: boolean;
};

type ConversionState = {
  userId: number;
  fileId: string;
  kind: ConversionKind;
  pack: boolean;
  expiresAt: number;
};

const actions = {
  video: [
    { kind: "video-animation", label: "🎞 گیف/انیمیشن", message: "انیمیشن آماده شد." },
    { kind: "video-sticker", label: "🎟 استیکر ویدیویی", message: "استیکر ویدیویی آماده شد." },
    { kind: "video-sticker", label: "➕ افزودن به پک", message: "استیکر به پک اضافه شد.", pack: true },
  ],
  photo: [
    { kind: "photo-sticker", label: "🎟 استیکر ثابت", message: "استیکر ثابت آماده شد." },
    { kind: "photo-sticker", label: "➕ افزودن به پک", message: "استیکر به پک اضافه شد.", pack: true },
    { kind: "photo-animation", label: "🎞 تبدیل به گیف", message: "گیف آماده شد." },
  ],
  animation: [
    { kind: "video-sticker", label: "🎟 استیکر ویدیویی", message: "استیکر ویدیویی آماده شد." },
    { kind: "video-sticker", label: "➕ افزودن به پک", message: "استیکر به پک اضافه شد.", pack: true },
  ],
  staticSticker: [
    { kind: "sticker-image", label: "🖼 تبدیل به تصویر", message: "تصویر آماده شد." },
    { kind: "photo-animation", label: "🎞 تبدیل به گیف", message: "گیف آماده شد." },
  ],
  videoSticker: [
    { kind: "sticker-animation", label: "🎞 تبدیل به انیمیشن", message: "انیمیشن آماده شد." },
  ],
} satisfies Record<string, ConversionAction[]>;

async function createConversion(
  userId: number,
  fileId: string,
  kind: ConversionKind,
  pack = false
) {
  const token = randomBytes(12).toString("hex");
  const key = `media_conversion:${token}`;
  const data: ConversionState = {
    userId,
    fileId,
    kind,
    pack,
    expiresAt: Date.now() + CONVERSION_TTL_MS,
  };
  await getDb().insert(cache).values({ key, data });
  return token;
}

async function takeConversion(token: string, userId: number) {
  const key = `media_conversion:${token}`;
  const [row] = await getDb().select({ data: cache.data }).from(cache).where(eq(cache.key, key));
  const state = row?.data as ConversionState | undefined;
  if (!state || state.userId !== userId || state.expiresAt <= Date.now()) {
    if (state?.expiresAt && state.expiresAt <= Date.now()) {
      await getDb().delete(cache).where(eq(cache.key, key));
    }
    return null;
  }
  const removed = await getDb().delete(cache).where(eq(cache.key, key)).returning({ key: cache.key });
  return removed.length ? state : null;
}

async function replyWithChoices(
  ctx: Context,
  file: { fileId: string; size?: number },
  choices: ConversionAction[],
  replyToMessageId: number
) {
  if (file.size !== undefined && file.size > MAX_INPUT_BYTES) {
    await ctx.reply("📦 فایل از سقف دانلود ۲۰ مگابایت تلگرام بیشتر است.", {
      reply_parameters: { message_id: replyToMessageId },
    });
    return;
  }

  const keyboard = new InlineKeyboard();
  const user = ctx.from;
  if (!user) throw new Error("Cannot create media conversion without a Telegram user");
  for (const choice of choices) {
    const token = await createConversion(user.id, file.fileId, choice.kind, choice.pack);
    keyboard.text(choice.label, `c:${token}`).row();
  }
  await ctx.reply("رسانه دریافت شد؛ نوع تبدیل را انتخاب کن:", {
    reply_parameters: { message_id: replyToMessageId },
    reply_markup: keyboard,
  });
}

async function handleMediaInput(
  ctx: Context,
  expectedMode: "media_stickers" | "media_video_note",
  file: { fileId: string; size?: number },
  choices: ConversionAction[],
  wrongModeMessage: string,
  replyToMessageId: number
) {
  const user = ctx.from;
  if (!user) return;
  const mode = await getMode(user.id);
  if (mode !== expectedMode) {
    if (mode === "media_stickers" || mode === "media_video_note") {
      await ctx.reply(wrongModeMessage);
    }
    return;
  }
  await clearMode(user.id);
  await replyWithChoices(ctx, file, choices, replyToMessageId);
}

function mediaGuide(mode: "media_stickers" | "media_video_note") {
  const keyboard = new InlineKeyboard()
    .text("لغو", "media:cancel")
    .text("🏠 منوی اصلی", "menu:home");
  return mode === "media_stickers"
    ? {
        text: "🎨 <b>استیکر و گیف</b>\nیک ویدیو، GIF، عکس یا استیکر ثابت/ویدیویی بفرست. فقط همین رسانه پردازش می‌شود؛ برای رسانهٔ بعدی دوباره وارد این بخش شو.",
        keyboard,
      }
    : {
        text: "⭕ <b>ویدیو مسیج</b>\nیک ویدیو بفرست تا به ویدیو مسیج تبدیل شود. ویدیوهای بیشتر از ۶۰ ثانیه خودکار تا ۶۰ ثانیه بریده می‌شوند.",
        keyboard,
      };
}

function outputName(kind: ConversionKind) {
  return `converted${conversionExtension(kind)}`;
}

async function deliver(ctx: Context, path: string, kind: ConversionKind) {
  const file = new InputFile(path, outputName(kind));
  if (kind === "video-note") {
    await ctx.replyWithVideoNote(file, { length: 640 });
  } else if (kind === "video-animation" || kind === "photo-animation" || kind === "sticker-animation") {
    await ctx.replyWithAnimation(file);
  } else if (kind === "video-sticker" || kind === "photo-sticker") {
    await ctx.replyWithSticker(file);
  } else {
    await ctx.replyWithPhoto(file);
  }
}

function stickerName(userId: number, kind: "static" | "video", botUsername: string) {
  const userHash = createHash("sha256").update(String(userId)).digest("hex").slice(0, 12);
  return `media_${kind === "static" ? "s" : "v"}_${userHash}_by_${botUsername}`;
}

async function addToStickerPack(ctx: Context, path: string, kind: ConversionKind) {
  const format: "static" | "video" = kind === "photo-sticker" ? "static" : "video";
  const me = await ctx.api.getMe();
  if (!me.username) throw new Error("Bot username is required to create a sticker set");

  const name = stickerName(ctx.from!.id, format, me.username);
  const sticker = {
    sticker: new InputFile(path, outputName(kind)),
    format,
    emoji_list: ["🙂"],
  };

  let stickerSetExists = true;
  try {
    await ctx.api.getStickerSet(name);
  } catch (error) {
    if (!(error instanceof GrammyError) || error.error_code !== 400) throw error;
    stickerSetExists = false;
  }

  if (stickerSetExists) {
    await ctx.api.addStickerToSet(ctx.from!.id, name, sticker);
  } else {
    await ctx.api.createNewStickerSet(
      ctx.from!.id,
      name,
      "استیکرهای ساخته‌شده",
      [sticker]
    );
  }

  return `https://t.me/addstickers/${name}`;
}

function userFacingError(error: unknown) {
  if (error instanceof UserError) return error.message;
  if (error instanceof GrammyError) {
    if (error.error_code === 413) return "📦 فایل برای ارسال از حد مجاز تلگرام بزرگ‌تر است.";
    if (error.error_code === 400) return "این قالب یا مشخصات فایل را تلگرام نپذیرفت؛ فایل دیگری را امتحان کن.";
  }
  return "⚠️ تبدیل رسانه انجام نشد. فایل را بررسی کن و دوباره تلاش کن.";
}

export function registerMediaConvert(bot: Bot) {
  bot.callbackQuery("menu:media:stickers", async (ctx) => {
    await ctx.answerCallbackQuery();
    await setMediaMode(ctx.from.id, "media_stickers");
    const guide = mediaGuide("media_stickers");
    await ctx.reply(guide.text, { parse_mode: "HTML", reply_markup: guide.keyboard });
  });

  bot.callbackQuery("menu:media:video_note", async (ctx) => {
    await ctx.answerCallbackQuery();
    await setMediaMode(ctx.from.id, "media_video_note");
    const guide = mediaGuide("media_video_note");
    await ctx.reply(guide.text, { parse_mode: "HTML", reply_markup: guide.keyboard });
  });

  bot.callbackQuery("media:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    await clearMode(ctx.from.id);
    await ctx.reply("✅ لغو شد. برای استفاده دوباره یکی از بخش‌های منو را انتخاب کن.", {
      reply_markup: new InlineKeyboard().text("🏠 منوی اصلی", "menu:home"),
    });
  });

  bot.on("message:video", async (ctx) => {
    const video = ctx.message.video;
    const mode = await getMode(ctx.from.id);
    if (mode === "media_video_note") {
      await handleMediaInput(
        ctx,
        "media_video_note",
        { fileId: video.file_id, size: video.file_size },
        [{ kind: "video-note", label: "⭕ تبدیل به ویدیو مسیج", message: "ویدیو مسیج آماده شد." }],
        "",
        ctx.message.message_id
      );
    } else if (mode === "media_stickers") {
      await handleMediaInput(
        ctx,
        "media_stickers",
        { fileId: video.file_id, size: video.file_size },
        actions.video,
        "",
        ctx.message.message_id
      );
    }
  });

  bot.on("message:video_note", async (ctx) => {
    const mode = await getMode(ctx.from.id);
    if (mode === "media_stickers" || mode === "media_video_note") {
      await ctx.reply("برای تبدیل، یک ویدیو معمولی بفرست؛ پیام ویدیویی ورودی پشتیبانی نمی‌شود.");
    }
  });

  bot.on("message:animation", async (ctx) => {
    const animation = ctx.message.animation;
    await handleMediaInput(
      ctx,
      "media_stickers",
      { fileId: animation.file_id, size: animation.file_size },
      actions.animation,
      "برای تبدیل GIF، از منوی «استیکر و گیف» وارد شو.",
      ctx.message.message_id
    );
  });

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    await handleMediaInput(
      ctx,
      "media_stickers",
      { fileId: photo.file_id, size: photo.file_size },
      actions.photo,
      "برای تبدیل عکس، از منوی «استیکر و گیف» وارد شو.",
      ctx.message.message_id
    );
  });

  bot.on("message:sticker", async (ctx) => {
    const sticker = ctx.message.sticker;
    const mode = await getMode(ctx.from.id);
    if (mode !== "media_stickers") {
      if (mode === "media_video_note") {
        await ctx.reply("برای این تبدیل، از منوی «استیکر و گیف» وارد شو.");
      }
      return;
    }
    if (sticker.is_animated && !sticker.is_video) {
      await ctx.reply("استیکرهای TGS فعلاً پشتیبانی نمی‌شوند.", {
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }
    const choices = sticker.is_video ? actions.videoSticker : actions.staticSticker;
    await handleMediaInput(
      ctx,
      "media_stickers",
      { fileId: sticker.file_id, size: sticker.file_size },
      choices,
      "",
      ctx.message.message_id
    );
  });

  bot.callbackQuery(/^c:(\w+)$/, async (ctx) => {
    const state = await takeConversion(ctx.match[1], ctx.from.id);
    if (!state) {
      await ctx.answerCallbackQuery({ text: "این گزینه منقضی یا قبلاً استفاده شده است.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: "در حال تبدیل رسانه…" });
    const action = Object.values(actions).flat().find(
      (item) => item.kind === state.kind && Boolean("pack" in item && item.pack) === state.pack
    );
    let directory: string | null = null;
    try {
      directory = await mkdtemp(join(tmpdir(), "telegram-media-"));
      const inputPath = join(directory, "input");
      const outputPath = join(directory, `output${conversionExtension(state.kind)}`);
      const input = await downloadTelegramFile(ctx.api, state.fileId, MAX_INPUT_BYTES, 30_000);
      await writeFile(inputPath, input, { flag: "wx" });
      const size = await convertMedia(inputPath, outputPath, state.kind);
      if ((state.kind === "video-sticker" || state.kind === "photo-sticker") && size > MAX_STICKER_BYTES) {
        throw new UserError("استیکر خروجی باید کمتر از ۲۵۶ کیلوبایت باشد؛ این رسانه قابل فشرده‌سازی کافی نبود.");
      }
      if (size > MAX_OUTPUT_BYTES) throw new UserError("فایل خروجی بیش از سقف ۱۰ مگابایت است.");
      if (state.pack) {
        const stickerSetUrl = await addToStickerPack(ctx, outputPath, state.kind);
        await ctx.reply(`${action?.message ?? "استیکر به پک اضافه شد."}\n${stickerSetUrl}`);
      } else {
        await deliver(ctx, outputPath, state.kind);
        await ctx.reply(action?.message ?? "✅ تبدیل کامل شد.");
      }
    } catch (error) {
      if (!(error instanceof UserError)) {
        console.error("media conversion failed:", error instanceof Error ? error.message : "unknown");
        await logOperationalError("media.convert", error);
      }
      await ctx.reply(userFacingError(error));
    } finally {
      if (directory) {
        await rm(directory, { recursive: true, force: true }).catch((error) => {
          console.error("media temp cleanup failed:", error instanceof Error ? error.message : "unknown");
        });
      }
    }
  });

  bot.callbackQuery(/^c:/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "گزینهٔ تبدیل نامعتبر است.", show_alert: true });
  });
}
