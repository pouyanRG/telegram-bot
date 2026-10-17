import { InlineKeyboard, type Context } from "grammy";
import { VOICE, pickVoiceTier, formatResetIn } from "./config";
import { UserError } from "./errors";
import { chargeJob, dailyLimit, getUsedToday, getUserState } from "./tokens";
import { failJob, finishJob, reapStaleJobs, startJob } from "./jobs";
import { downloadTelegramFile } from "./telegramFile";
import { oggOpusDurationSec } from "./ogg";
import { withThinking } from "./admins";
import { transcribeAudio } from "./gemini";

const PRO_REQUIRED = "💎 ویس‌های بین ۵ تا ۱۰ دقیقه فقط برای کاربران پرو فعال است.";
const TOO_LONG = "⏱ حداکثر مدت ویس ۱۰ دقیقه است.";

const chunk = (s: string, n = 4000) =>
  Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, (i + 1) * n));

export async function voiceGuide(ctx: Context) {
  const userId = ctx.from?.id;
  let extra = "";
  if (userId) {
    const u = await getUserState(userId);
    if (u) {
      const limit = dailyLimit(u.isPro);
      const left = Math.max(limit - (await getUsedToday(userId)), 0);
      extra = `\n\n🎟 توکن باقی‌مانده امروز: ${left} از ${limit}${u.isPro ? " 💎" : ""}`;
    }
  }
  await ctx.reply(
    [
      "🎙 یک ویس برایم بفرست تا متنش کنم.",
      "",
      "▫️ کمتر از ۱ دقیقه: ۲ توکن",
      "▫️ ۱ تا ۵ دقیقه: ۵ توکن",
      "▫️ ۵ تا ۱۰ دقیقه: فقط اشتراک پرو 💎",
    ].join("\n") + extra,
    { reply_markup: new InlineKeyboard().text("🏠 منوی اصلی", "menu:home") }
  );
}

export async function handleVoice(ctx: Context) {
  const msg = ctx.message;
  const voice = msg?.voice;
  const from = ctx.from;
  if (!msg || !voice || !from) return;
  const userId = from.id;
  const reply = (text: string) =>
    ctx.reply(text, { reply_parameters: { message_id: msg.message_id } });

  // ۱) فیلترهای ارزان، قبل از هر کار پرهزینه
  if (voice.duration > VOICE.maxSeconds) return void (await reply(TOO_LONG));
  if (!voice.file_size || voice.file_size > VOICE.maxBytes) {
    return void (await reply("📦 حجم این ویس بیش از حد مجاز است."));
  }
  if (voice.mime_type && voice.mime_type !== "audio/ogg") {
    return void (await reply("فرمت این ویس پشتیبانی نمی‌شود."));
  }

  // ۲) وضعیت کاربر
  const user = await getUserState(userId);
  if (!user || user.isBanned) return;
  const limit = dailyLimit(user.isPro);

  const declaredTier = pickVoiceTier(voice.duration);
  if (!declaredTier) return void (await reply(TOO_LONG));
  if (declaredTier.pro && !user.isPro) return void (await reply(PRO_REQUIRED));

  // ۳) گرفتن slot (ضد تکرار وبهوک و ضد ویس موازی)
  await reapStaleJobs(userId);
  const job = await startJob({
    userId,
    chatId: ctx.chat!.id,
    messageId: msg.message_id,
    fileUniqueId: voice.file_unique_id,
    declaredSec: voice.duration,
  });
  if (job.status === "duplicate") return; // تلگرام دوباره ارسال کرده
  if (job.status === "busy") {
    return void (await reply("⏳ ویس قبلی‌ات هنوز در حال پردازش است. کمی صبر کن."));
  }

  try {
    await ctx.replyWithChatAction("typing");

    // ۴) دانلود و تأیید مدت واقعی
    const audio = await downloadTelegramFile(ctx.api, voice.file_id, VOICE.maxBytes);
    const realSec = oggOpusDurationSec(audio);
    if (realSec === null) throw new UserError("این فایل یک ویس معتبر نیست.");

    const billedSec = Math.ceil(Math.max(voice.duration, realSec));
    const tier = pickVoiceTier(billedSec);
    if (!tier) throw new UserError(TOO_LONG);
    if (tier.pro && !user.isPro) throw new UserError(PRO_REQUIRED);

    // ۵) کسر اتمیک توکن (شامل چک مسدودی)
    const charge = await chargeJob({ jobId: job.id, userId, cost: tier.cost, limit });
    if (!charge) {
      const left = Math.max(limit - (await getUsedToday(userId)), 0);
      throw new UserError(
        [
          `⏳ توکن کافی نداری. این ویس ${tier.cost} توکن لازم دارد و ${left} توکن باقی مانده است.`,
          `ریست توکن‌ها: ${formatResetIn()} دیگر`,
        ].join("\n")
      );
    }

    // ۶) Gemini
    const maxOut = Math.min(8192, 400 + billedSec * 25);
    const { text, promptTokens } = await withThinking(ctx, () => transcribeAudio(audio, "audio/ogg", maxOut));
    if (!text) throw new UserError("🔇 صدای قابل‌فهمی پیدا نشد. توکن برگردانده شد.");

    // نشانه‌ی دوم: Gemini حدود ۳۲ توکن در ثانیه برای صدا حساب می‌کند
    if (promptTokens && promptTokens / 32 > Math.max(billedSec * 1.5, billedSec + 15)) {
      console.warn("voice-duration-mismatch", { userId, billedSec, promptTokens });
    }

    // ۷) تثبیت job؛ اگر وسط کار reap شده باشد، نتیجه تحویل داده نمی‌شود
    if (!(await finishJob(job.id, billedSec))) {
      throw new UserError("⚠️ پردازش طولانی شد و لغو شد. توکن برگردانده شد؛ دوباره بفرست.");
    }

    // ۸) ارسال نتیجه. از اینجا به بعد job در وضعیت done است و failJob اثری ندارد،
    // پس خطای ارسال نباید به کاربر بگوید «توکن برگردانده شد».
    try {
      // متن ساده، بدون parse_mode: خروجی مدل را قابل‌اعتماد فرض نمی‌کنیم
      for (const part of chunk(text)) {
        await ctx.reply(part, {
          reply_parameters: { message_id: msg.message_id },
          link_preview_options: { is_disabled: true },
        });
      }
      await ctx.reply(
        `🎙 ${billedSec} ثانیه • ${tier.cost} توکن • باقی‌مانده امروز: ${Math.max(limit - charge.used, 0)}`
      );
    } catch (sendErr) {
      console.error("voice send error:", sendErr instanceof Error ? sendErr.message : "unknown");
      await reply("⚠️ متن آماده شد ولی ارسالش ناموفق بود. توکن این ویس کسر شده است.").catch(() => {});
    }
  } catch (e) {
    await failJob(job.id).catch((err) => console.error("failJob error:", err));
    if (e instanceof UserError) {
      await reply(e.message);
    } else {
      console.error("voice error:", e instanceof Error ? e.message : "unknown");
      await reply("⚠️ مشکلی پیش آمد. اگر توکنی کسر شده بود برگردانده شد. کمی بعد دوباره امتحان کن.");
    }
  }
}