import { and, count, desc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm";
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";
import { getDb } from "./db";
import {
  ADMIN_PERMISSIONS,
  addAdmin,
  clearThinkingSticker,
  getAdminTitle,
  getThinkingSticker,
  hasAdminPermission,
  isAdminUser,
  isOwner,
  listAdmins,
  ownerId,
  recordAdminAction,
  removeAdmin,
  setPendingSticker,
  setThinkingSticker,
  takePendingSticker,
  updateAdmin,
  type AdminPermission,
} from "./admins";
import {
  getAdminRateLimit,
  getMaintenanceMode,
  isFeatureEnabled,
  MANAGED_FEATURES,
  setAdminRateLimit,
  setFeatureEnabled,
  setMaintenanceMode,
} from "./adminControls";
import {
  admins,
  adminAuditLogs,
  bans,
  cache,
  feedback,
  operationalErrors,
  reports,
  users,
  voiceJobs,
} from "./schema";
import { BTN, mainMenu } from "./menu";
import { clearMode } from "./mode";
import { clearReport } from "./reports";
import { buildAdminExport, collectHealthChecks } from "./adminObservability";

const HTML = { parse_mode: "HTML" as const };
const PAGE_SIZE = 8;
const BACK = new InlineKeyboard().text("🔙 بازگشت", "menu:settings");
type PendingInput = { kind: string; target?: number };

const ADMIN_PRESETS: Record<
  string,
  { title: string; permissions: AdminPermission[]; label: string }
> = {
  support: {
    title: "پشتیبان",
    label: "پشتیبان",
    permissions: ["users_view", "reports_manage", "feedback_manage"],
  },
  moderator: {
    title: "ناظر",
    label: "ناظر",
    permissions: ["dashboard", "users_view", "users_manage", "reports_manage", "audit_view"],
  },
  operator: {
    title: "مدیر فنی",
    label: "مدیر فنی",
    permissions: [
      "dashboard",
      "sticker_manage",
      "maintenance_manage",
      "features_manage",
      "rate_limit_manage",
      "audit_view",
    ],
  },
  custom: {
    title: "ادمین",
    label: "بدون قالب",
    permissions: [],
  },
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function fromId(ctx: Context) {
  if (!ctx.from) throw new Error("Telegram user is required for admin interaction");
  return ctx.from.id;
}

function parseId(raw: unknown) {
  const id = Number(String(raw ?? "").trim());
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function edit(ctx: Context, text: string, keyboard: InlineKeyboard) {
  try {
    await ctx.editMessageText(text, { ...HTML, reply_markup: keyboard });
  } catch (error) {
    if (error instanceof GrammyError && error.description.includes("message is not modified")) return;
    if (error instanceof GrammyError) {
      await ctx.reply(text, { ...HTML, reply_markup: keyboard });
      return;
    }
    throw error;
  }
}

async function permitted(ctx: Context, permission: AdminPermission) {
  if (await hasAdminPermission(fromId(ctx), permission)) return true;
  await ctx.answerCallbackQuery({ text: "⛔️ دسترسی این بخش برای شما فعال نیست.", show_alert: true })
    .catch(() => {});
  return false;
}

function inputKey(id: number) {
  return `admin_input:${id}`;
}

async function setInput(id: number, value: { kind: string; target?: number }) {
  const db = getDb();
  const data = value;
  await db
    .insert(cache)
    .values({ key: inputKey(id), data })
    .onConflictDoUpdate({
      target: cache.key,
      set: { data, updatedAt: new Date() },
    });
}

async function takeInput(id: number) {
  const [row] = await getDb()
    .delete(cache)
    .where(eq(cache.key, inputKey(id)))
    .returning({ data: cache.data });
  const data = row?.data as PendingInput | undefined;
  return data && typeof data.kind === "string" ? data : null;
}

async function promptInput(ctx: Context, prompt: string, state: PendingInput) {
  await setInput(fromId(ctx), state);
  await ctx.reply(prompt, {
    reply_markup: new InlineKeyboard().text("❌ انصراف", "admin:input:cancel"),
  });
}

function settingsKeyboard(allowed: Set<AdminPermission>, owner: boolean) {
  const kb = new InlineKeyboard();
  if (allowed.has("dashboard")) kb.text("📊 داشبورد و آمار", "admin:dashboard").row();
  if (allowed.has("users_view")) kb.text("👥 کاربران", "admin:users").row();
  if (allowed.has("reports_manage")) kb.text("🚨 گزارش‌ها", "admin:reports").row();
  if (allowed.has("feedback_manage")) kb.text("📮 بازخوردها", "admin:feedback").row();
  if (allowed.has("sticker_manage")) kb.text("🎞 استیکر پردازش", "admin:sticker").row();
  if (allowed.has("maintenance_manage")) kb.text("🛠 حالت تعمیرات", "admin:maintenance").row();
  if (allowed.has("features_manage")) kb.text("🎛 قابلیت‌ها", "admin:features").row();
  if (allowed.has("rate_limit_manage")) kb.text("⏱ محدودیت نرخ", "admin:rate").row();
  if (allowed.has("audit_view")) kb.text("🧾 گزارش اقدامات", "admin:audit").row();
  if (allowed.has("health_view")) kb.text("🩺 سلامت سرویس‌ها", "admin:health").row();
  if (allowed.has("errors_view")) kb.text("🚨 خطاهای مهم", "admin:errors").row();
  if (allowed.has("export_data")) kb.text("📤 خروجی و پشتیبان", "admin:export").row();
  if (owner) kb.text("🛡 مدیریت ادمین‌ها", "admin:staff:list").row();
  return kb.text("🏠 منوی اصلی", "menu:home");
}

async function showSettings(ctx: Context) {
  const id = fromId(ctx);
  const title = await getAdminTitle(id);
  const allowed = new Set<AdminPermission>();
  for (const permission of ADMIN_PERMISSIONS) {
    if (await hasAdminPermission(id, permission.key)) allowed.add(permission.key);
  }
  const text = `⚙️ <b>مدیریت ربات</b>\nدسترسی: ${escapeHtml(title)}\nگزینه‌های قابل‌دسترسی برای حساب شما:`;
  const keyboard = settingsKeyboard(allowed, isOwner(id));
  if (ctx.callbackQuery) {
    await edit(ctx, text, keyboard);
  } else {
    await ctx.reply(text, { ...HTML, reply_markup: keyboard });
  }
}

async function showDashboard(ctx: Context) {
  const db = getDb();
  const [[total], [active], [banned], [reportsPending], [feedbackPending], [failedJobs]] =
    await Promise.all([
      db.select({ value: count() }).from(users),
      db.select({ value: count() }).from(users).where(gt(users.lastSeenAt, sql`now() - interval '24 hours'`)),
      db.select({ value: count() }).from(users).where(eq(users.isBanned, true)),
      db.select({ value: count() }).from(reports).where(eq(reports.status, "pending")),
      db.select({ value: count() }).from(feedback).where(eq(feedback.status, "pending")),
      db.select({ value: count() }).from(voiceJobs).where(
        and(eq(voiceJobs.status, "failed"), gt(voiceJobs.createdAt, sql`now() - interval '24 hours'`))
      ),
    ]);

  await edit(
    ctx,
    [
      "📊 <b>داشبورد مدیریت</b>",
      "",
      `👥 کاربران: ${total.value}`,
      `🟢 فعال در ۲۴ ساعت اخیر: ${active.value}`,
      `⛔️ مسدود: ${banned.value}`,
      `🚨 گزارش‌های بررسی‌نشده: ${reportsPending.value}`,
      `📮 بازخوردهای بررسی‌نشده: ${feedbackPending.value}`,
      `⚠️ کارهای ویس ناموفق در ۲۴ ساعت: ${failedJobs.value}`,
    ].join("\n"),
    new InlineKeyboard().text("🔄 بروزرسانی", "admin:dashboard").row().text("🔙 بازگشت", "menu:settings")
  );
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

async function showUsers(ctx: Context, page: number, search: string) {
  const term = search.trim().replace(/^@/, "");
  const numericId = Number(term);
  const where = term
    ? or(
        ilike(users.username, `%${escapeLike(term)}%`),
        ilike(users.firstName, `%${escapeLike(term)}%`),
        Number.isSafeInteger(numericId) ? eq(users.telegramId, numericId) : undefined
      )
    : undefined;
  const db = getDb();
  const [matched] = await db.select({ value: count() }).from(users).where(where);
  const totalPages = Math.max(1, Math.ceil(matched.value / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const rows = await db
    .select({
      id: users.telegramId,
      username: users.username,
      firstName: users.firstName,
      banned: users.isBanned,
      lastSeen: users.lastSeenAt,
    })
    .from(users)
    .where(where)
    .orderBy(desc(users.lastSeenAt))
    .limit(PAGE_SIZE)
    .offset(currentPage * PAGE_SIZE);

  const keyboard = new InlineKeyboard();
  for (const user of rows) {
    const name = user.username ? `@${user.username}` : (user.firstName ?? String(user.id));
    keyboard.text(`${user.banned ? "⛔️" : "👤"} ${name}`.slice(0, 60), `admin:user:${user.id}`).row();
  }
  if (currentPage > 0) keyboard.text("⬅️ قبلی", `admin:users:page:${currentPage - 1}`);
  if (currentPage + 1 < totalPages) keyboard.text("بعدی ➡️", `admin:users:page:${currentPage + 1}`);
  if (currentPage > 0 || currentPage + 1 < totalPages) keyboard.row();
  keyboard
    .text("🔎 جستجو", "admin:users:search")
    .text("🧹 پاک‌کردن جستجو", "admin:users:clear")
    .row()
    .text("🔙 بازگشت", "menu:settings");

  const label = term ? `\nجستجو: <code>${escapeHtml(term)}</code>` : "";
  await edit(
    ctx,
    `👥 <b>کاربران</b>${label}\n${matched.value} نتیجه · صفحه ${currentPage + 1} از ${totalPages}`,
    keyboard
  );
}

async function showUser(ctx: Context, id: number) {
  const [user] = await getDb().select().from(users).where(eq(users.telegramId, id));
  if (!user) {
    await edit(ctx, "کاربر پیدا نشد.", new InlineKeyboard().text("⬅️ کاربران", "admin:users"));
    return;
  }
  const keyboard = new InlineKeyboard();
  if (isOwner(fromId(ctx))) {
    const [existingAdmin] = await getDb().select({ userId: admins.userId }).from(admins).where(eq(admins.userId, id));
    if (!existingAdmin && !isOwner(id)) {
      keyboard.text("➕ افزودن به ادمین‌ها", `admin:staff:add:${id}`).row();
    }
  }
  if (await hasAdminPermission(fromId(ctx), "users_manage")) {
    if (user.isBanned) {
      keyboard.text("✅ رفع مسدودی", `admin:user:unban:${id}`).row();
    } else {
      keyboard
        .text("⛔️ ۲۴ ساعت", `admin:user:ban:${id}:24`)
        .text("⛔️ ۷ روز", `admin:user:ban:${id}:168`)
        .row()
        .text("⛔️ دائمی", `admin:user:ban:${id}:0`)
        .row();
    }
  }
  keyboard.text("⬅️ کاربران", "admin:users").row().text("⚙️ مدیریت", "menu:settings");
  const when = user.banUntil?.toLocaleString("fa-IR", { timeZone: "Asia/Tehran" }) ?? "دائمی";
  await edit(
    ctx,
    [
      `👤 <b>کاربر ${user.username ? `@${escapeHtml(user.username)}` : ""}</b>`,
      `شناسه: <code>${user.telegramId}</code>`,
      `نام: ${escapeHtml(user.firstName ?? "—")}`,
      `زبان: ${escapeHtml(user.language ?? "—")}`,
      `عضویت: ${user.createdAt.toLocaleDateString("fa-IR", { timeZone: "Asia/Tehran" })}`,
      `آخرین فعالیت: ${user.lastSeenAt.toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}`,
      `سکه: ${user.coins}`,
      `اشتراک Pro تا: ${user.proUntil?.toLocaleDateString("fa-IR", { timeZone: "Asia/Tehran" }) ?? "—"}`,
      `وضعیت: ${user.isBanned ? `مسدود (تا ${when})` : "فعال"}`,
    ].join("\n"),
    keyboard
  );
}

async function banUser(actorId: number, userId: number, hours: number | null) {
  const until = hours === null ? null : new Date(Date.now() + hours * 60 * 60 * 1000);
  await getDb().transaction(async (tx) => {
    const [existing] = await tx.select({ id: users.telegramId }).from(users).where(eq(users.telegramId, userId));
    if (!existing) return;
    await tx.update(users).set({ isBanned: true, banUntil: until }).where(eq(users.telegramId, userId));
    await tx
      .update(bans)
      .set({ unbannedAt: new Date() })
      .where(and(eq(bans.userId, userId), isNull(bans.unbannedAt)));
    await tx.insert(bans).values({
      userId,
      reason: hours === null ? "admin_permanent" : `admin_${hours}h`,
      bannedBy: String(actorId),
      banUntil: until,
    });
  });
}

async function unbanUser(userId: number) {
  await getDb().transaction(async (tx) => {
    await tx.update(users).set({ isBanned: false, banUntil: null }).where(eq(users.telegramId, userId));
    await tx
      .update(bans)
      .set({ unbannedAt: new Date() })
      .where(and(eq(bans.userId, userId), isNull(bans.unbannedAt)));
  });
}

async function showStaff(ctx: Context, userId: number) {
  const [admin] = await getDb().select().from(admins).where(eq(admins.userId, userId));
  if (!admin) return void (await edit(ctx, "ادمین پیدا نشد.", BACK));
  const keyboard = new InlineKeyboard();
  for (const permission of ADMIN_PERMISSIONS) {
    const enabled = admin.permissions.includes(permission.key);
    keyboard
      .text(`${enabled ? "✅" : "▫️"} ${permission.label}`, `admin:staff:toggle:${userId}:${permission.key}`)
      .row();
  }
  keyboard.text("✏️ تغییر لقب", `admin:staff:title:${userId}`).row();
  keyboard.text("🗑 حذف دسترسی ادمین", `admin:staff:remove:${userId}`).row();
  keyboard.text("⬅️ فهرست ادمین‌ها", "admin:staff:list");
  await edit(
    ctx,
    `🛡 <b>مدیریت ادمین</b>\nشناسه: <code>${userId}</code>\nلقب: ${escapeHtml(admin.title ?? "ادمین فرعی")}\n\nدسترسی‌ها را جداگانه فعال یا غیرفعال کن.`,
    keyboard
  );
}

function addAdminWizardKeyboard(userId: number) {
  return new InlineKeyboard()
    .text("📮 پشتیبان", `admin:staff:setup:${userId}:support`)
    .text("🛡 ناظر", `admin:staff:setup:${userId}:moderator`)
    .row()
    .text("⚙️ مدیر فنی", `admin:staff:setup:${userId}:operator`)
    .text("🎛 انتخاب دستی", `admin:staff:setup:${userId}:custom`)
    .row()
    .text("❌ انصراف", "admin:staff:list");
}

async function beginAddAdmin(ctx: Context, userId: number) {
  if (!Number.isSafeInteger(userId) || userId <= 0 || isOwner(userId)) {
    await ctx.answerCallbackQuery({ text: "شناسهٔ کاربر معتبر نیست.", show_alert: true }).catch(() => {});
    return;
  }
  const [existing] = await getDb().select({ userId: admins.userId }).from(admins).where(eq(admins.userId, userId));
  if (existing) {
    await ctx.answerCallbackQuery({ text: "این کاربر از قبل ادمین است." }).catch(() => {});
    await showStaff(ctx, userId);
    return;
  }
  await ctx.answerCallbackQuery().catch(() => {});
  await edit(
    ctx,
    `➕ <b>افزودن ادمین</b>\nکاربر: <code>${userId}</code>\n\nیک قالب دسترسی انتخاب کن. بعد از افزودن می‌توانی مجوزها و لقب را جداگانه ویرایش کنی.`,
    addAdminWizardKeyboard(userId)
  );
}

async function showFeedback(ctx: Context) {
  const db = getDb();
  const [pending] = await db.select({ value: count() }).from(feedback).where(eq(feedback.status, "pending"));
  const rows = await db
    .select()
    .from(feedback)
    .where(eq(feedback.status, "pending"))
    .orderBy(feedback.id)
    .limit(8);
  const keyboard = new InlineKeyboard();
  for (const item of rows) {
    keyboard.text(`📮 #${item.id} · ${item.userId}`, `admin:feedback:item:${item.id}`).row();
  }
  keyboard.text("🔙 بازگشت", "menu:settings");
  await edit(ctx, `📮 <b>بازخوردها</b>\nدر انتظار بررسی: ${pending.value}`, keyboard);
}

async function showFeedbackItem(ctx: Context, id: number) {
  const [item] = await getDb().select().from(feedback).where(eq(feedback.id, id));
  if (!item) return void (await edit(ctx, "این بازخورد پیدا نشد.", BACK));
  const keyboard = new InlineKeyboard()
    .text("✅ بستن بازخورد", `admin:feedback:close:${id}`)
    .row()
    .text("⬅️ فهرست بازخوردها", "admin:feedback");
  await edit(
    ctx,
    `📮 <b>بازخورد #${id}</b>\nکاربر: <code>${item.userId}</code>\nزمان: ${item.createdAt.toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}\n\n${escapeHtml(item.message)}`,
    keyboard
  );
}

export function registerAdminPanel(bot: Bot) {
  bot.hears(BTN.settings, async (ctx) => {
    if (!(await isAdminUser(fromId(ctx)))) {
      await ctx.reply("⛔️ فقط ادمین.");
      return;
    }
    await showSettings(ctx);
  });

  bot.hears(BTN.feedback, async (ctx) => {
    const userId = fromId(ctx);
    await clearReport(userId);
    await clearMode(userId);
    await takePendingSticker(userId);
    await promptInput(ctx, "📮 پیام یا پیشنهادت را در یک پیام بفرست (۱۰ تا ۲۰۰۰ نویسه).", {
      kind: "feedback",
    });
  });

  bot.on("message:text", async (ctx, next) => {
    const state = await takeInput(ctx.from.id);
    if (!state || ctx.message.text.startsWith("/")) return next();
    const text = ctx.message.text.trim();

    if (state.kind === "feedback") {
      if ([...text].length < 10 || [...text].length > 2000) {
        await promptInput(ctx, "متن باید بین ۱۰ تا ۲۰۰۰ نویسه باشد؛ دوباره بفرست.", state);
        return;
      }
      const [created] = await getDb()
        .insert(feedback)
        .values({ userId: ctx.from.id, message: text })
        .returning({ id: feedback.id });
      await ctx.reply("✅ بازخوردت ثبت شد. ممنون از اینکه کمک می‌کنی ربات بهتر شود.", {
        reply_markup: mainMenu(await isAdminUser(ctx.from.id)),
      });
      const owner = ownerId();
      if (owner) {
        await ctx.api.sendMessage(owner, `📮 بازخورد جدید #${created.id} ثبت شد.`).catch((e) => {
          console.error("feedback notification error:", e);
        });
      }
      return;
    }

    if (state.kind === "search") {
      if (!(await hasAdminPermission(ctx.from.id, "users_view"))) {
        return void (await ctx.reply("⛔️ دسترسی جستجوی کاربران برای شما فعال نیست."));
      }
      if (text.length > 64) {
        await promptInput(ctx, "عبارت جستجو حداکثر ۶۴ نویسه است؛ دوباره بفرست.", state);
        return;
      }
      const data = { value: text };
      await getDb()
        .insert(cache)
        .values({ key: `admin_search:${ctx.from.id}`, data })
        .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
      await showUsers(ctx, 0, text);
      return;
    }

    if (state.kind === "title" && state.target) {
      if (!isOwner(ctx.from.id)) return void (await ctx.reply("⛔️ فقط ادمین اصلی."));
      if ([...text].length < 2 || [...text].length > 32 || /[\u0000-\u001f]/.test(text)) {
        await promptInput(ctx, "لقب باید بین ۲ تا ۳۲ نویسه باشد؛ دوباره بفرست.", state);
        return;
      }
      await updateAdmin(state.target, { title: text });
      await recordAdminAction(ctx.from.id, "admin.title.update", state.target, { title: text });
      await ctx.reply(`✅ لقب ادمین به «${text}» تغییر کرد.`);
      return;
    }

    if (state.kind === "rate") {
      if (!(await hasAdminPermission(ctx.from.id, "rate_limit_manage"))) {
        return void (await ctx.reply("⛔️ دسترسی تغییر محدودیت نرخ را ندارید."));
      }
      const match = /^(\d{1,3})[\s,،/]+(\d{1,2})$/.exec(text);
      if (!match) {
        await promptInput(ctx, "دو عدد بفرست: تعداد در بازه (۱ تا ۱۰۰) و طول بازه به ثانیه (۱ تا ۶۰)، مثل 10 5.", state);
        return;
      }
      const settings = { limit: Number(match[1]), windowSeconds: Number(match[2]) };
      if (
        settings.limit < 1 ||
        settings.limit > 100 ||
        settings.windowSeconds < 1 ||
        settings.windowSeconds > 60
      ) {
        await promptInput(ctx, "مقادیر خارج از محدوده‌اند. مثل 10 5 بفرست.", state);
        return;
      }
      await setAdminRateLimit(settings);
      await recordAdminAction(ctx.from.id, "rate_limit.update", null, settings);
      await ctx.reply(`✅ محدودیت به ${settings.limit} پیام در ${settings.windowSeconds} ثانیه تغییر کرد.`);
      return;
    }

    return next();
  });

  bot.callbackQuery("admin:input:cancel", async (ctx) => {
    await takeInput(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "لغو شد" });
    await ctx.reply("عملیات لغو شد.");
  });

  bot.callbackQuery("menu:settings", async (ctx) => {
    if (!(await isAdminUser(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "⛔️ فقط ادمین.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await showSettings(ctx);
  });

  bot.callbackQuery("admin:dashboard", async (ctx) => {
    if (!(await permitted(ctx, "dashboard"))) return;
    await ctx.answerCallbackQuery();
    await showDashboard(ctx);
  });

  bot.callbackQuery("admin:users", async (ctx) => {
    if (!(await permitted(ctx, "users_view"))) return;
    await ctx.answerCallbackQuery();
    const [row] = await getDb().select().from(cache).where(eq(cache.key, `admin_search:${ctx.from.id}`));
    await showUsers(ctx, 0, (row?.data as { value?: string } | undefined)?.value ?? "");
  });

  bot.callbackQuery("admin:users:search", async (ctx) => {
    if (!(await permitted(ctx, "users_view"))) return;
    await ctx.answerCallbackQuery();
    await promptInput(ctx, "شناسه، نام یا نام کاربری را بفرست.", { kind: "search" });
  });

  bot.callbackQuery("admin:users:clear", async (ctx) => {
    if (!(await permitted(ctx, "users_view"))) return;
    await getDb().delete(cache).where(eq(cache.key, `admin_search:${ctx.from.id}`));
    await ctx.answerCallbackQuery();
    await showUsers(ctx, 0, "");
  });

  bot.callbackQuery(/^admin:users:page:(\d+)$/, async (ctx) => {
    if (!(await permitted(ctx, "users_view"))) return;
    const [row] = await getDb().select().from(cache).where(eq(cache.key, `admin_search:${ctx.from.id}`));
    await ctx.answerCallbackQuery();
    await showUsers(ctx, Number(ctx.match[1]), (row?.data as { value?: string } | undefined)?.value ?? "");
  });

  bot.callbackQuery(/^admin:user:(\d+)$/, async (ctx) => {
    if (!(await permitted(ctx, "users_view"))) return;
    await ctx.answerCallbackQuery();
    await showUser(ctx, Number(ctx.match[1]));
  });

  bot.callbackQuery(/^admin:user:ban:(\d+):(0|24|168)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    if (!(await permitted(ctx, "users_manage"))) return;
    if (id === ctx.from.id || isOwner(id)) {
      await ctx.answerCallbackQuery({ text: "این کاربر را نمی‌توان مسدود کرد.", show_alert: true });
      return;
    }
    const hours = Number(ctx.match[2]) || null;
    await banUser(ctx.from.id, id, hours);
    await recordAdminAction(ctx.from.id, "user.ban", id, { hours });
    await ctx.answerCallbackQuery({ text: "کاربر مسدود شد." });
    await showUser(ctx, id);
  });

  bot.callbackQuery(/^admin:user:unban:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    if (!(await permitted(ctx, "users_manage"))) return;
    await unbanUser(id);
    await recordAdminAction(ctx.from.id, "user.unban", id);
    await ctx.answerCallbackQuery({ text: "مسدودی برداشته شد." });
    await showUser(ctx, id);
  });

  bot.callbackQuery("admin:staff:list", async (ctx) => {
    if (!isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "⛔️ فقط ادمین اصلی.", show_alert: true });
      return;
    }
    const list = await listAdmins();
    const keyboard = new InlineKeyboard();
    for (const admin of list) {
      keyboard.text(
        `${admin.title ?? "ادمین"} · ${admin.userId}`.slice(0, 60),
        `admin:staff:open:${admin.userId}`
      ).row();
    }
    keyboard.text("🔙 بازگشت", "menu:settings");
    await ctx.answerCallbackQuery();
    await edit(ctx, `🛡 <b>ادمین‌های فرعی</b>\nتعداد: ${list.length}\n\nبرای افزودن از دستور /addadmin استفاده کن.`, keyboard);
  });

  bot.callbackQuery(/^admin:staff:open:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) return void (await ctx.answerCallbackQuery({ text: "⛔️ فقط ادمین اصلی.", show_alert: true }));
    await ctx.answerCallbackQuery();
    await showStaff(ctx, Number(ctx.match[1]));
  });

  bot.callbackQuery(/^admin:staff:toggle:(\d+):([a-z_]+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) return void (await ctx.answerCallbackQuery({ text: "⛔️ فقط ادمین اصلی.", show_alert: true }));
    const targetId = Number(ctx.match[1]);
    const key = ctx.match[2] as AdminPermission;
    if (!ADMIN_PERMISSIONS.some((item) => item.key === key)) return void (await ctx.answerCallbackQuery());
    const [admin] = await getDb().select().from(admins).where(eq(admins.userId, targetId));
    if (!admin) return void (await ctx.answerCallbackQuery({ text: "ادمین پیدا نشد." }));
    const permissions: AdminPermission[] = admin.permissions.filter(
      (permission): permission is AdminPermission =>
        ADMIN_PERMISSIONS.some((item) => item.key === permission)
    );
    const updatedPermissions = permissions.includes(key)
      ? permissions.filter((permission) => permission !== key)
      : [...permissions, key];
    await updateAdmin(targetId, { permissions: updatedPermissions });
    await recordAdminAction(ctx.from.id, "admin.permission.update", targetId, { permission: key, enabled: updatedPermissions.includes(key) });
    await ctx.answerCallbackQuery({ text: "دسترسی‌ها ذخیره شد." });
    await showStaff(ctx, targetId);
  });

  bot.callbackQuery(/^admin:staff:title:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) return void (await ctx.answerCallbackQuery({ text: "⛔️ فقط ادمین اصلی.", show_alert: true }));
    await ctx.answerCallbackQuery();
    await promptInput(ctx, "لقب جدید را بفرست (۲ تا ۳۲ نویسه).", {
      kind: "title",
      target: Number(ctx.match[1]),
    });
  });

  bot.callbackQuery(/^admin:staff:remove:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) return void (await ctx.answerCallbackQuery({ text: "⛔️ فقط ادمین اصلی.", show_alert: true }));
    const id = Number(ctx.match[1]);
    await removeAdmin(id);
    await recordAdminAction(ctx.from.id, "admin.remove", id);
    await ctx.answerCallbackQuery({ text: "دسترسی ادمین حذف شد." });
    await edit(ctx, "دسترسی ادمین حذف شد.", new InlineKeyboard().text("⬅️ فهرست", "admin:staff:list"));
    await ctx.api.sendMessage(id, "دسترسی ادمین شما برداشته شد.").catch((e) => {
      console.error("admin removal notification error:", e);
    });
  });

  bot.command("addadmin", async (ctx) => {
    const actor = ctx.from?.id;
    if (!actor || !isOwner(actor)) return;
    const forwarded = ctx.message?.reply_to_message?.forward_origin;
    const forwardedId = forwarded?.type === "user" ? forwarded.sender_user.id : null;
    const id = parseId(ctx.match) ?? forwardedId;
    if (!id) {
      return void (await ctx.reply(
        "برای افزودن، از «تنظیمات ← کاربران» کاربر را جستجو و انتخاب کن؛ یا پیام او را برای بات فوروارد کن و با /addadmin به همان پیام پاسخ بده."
      ));
    }
    if (id === ownerId()) return void (await ctx.reply("تو ادمین اصلی هستی 👑"));
    await ctx.reply(
      `${forwardedId ? "کاربر شناسایی‌شده" : "کاربر"}: ${id}\nقالب دسترسی را انتخاب کن:`,
      { reply_markup: addAdminWizardKeyboard(id) }
    );
  });

  bot.callbackQuery(/^admin:staff:add:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "⛔️ فقط ادمین اصلی.", show_alert: true });
      return;
    }
    await beginAddAdmin(ctx, Number(ctx.match[1]));
  });

  bot.callbackQuery(/^admin:staff:setup:(\d+):(support|moderator|operator|custom)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "⛔️ فقط ادمین اصلی.", show_alert: true });
      return;
    }
    const userId = Number(ctx.match[1]);
    const preset = ADMIN_PRESETS[ctx.match[2]];
    const added = await addAdmin(userId, ctx.from.id);
    await updateAdmin(userId, { title: preset.title, permissions: preset.permissions });
    await recordAdminAction(ctx.from.id, added ? "admin.add" : "admin.preset.update", userId, {
      preset: ctx.match[2],
      permissions: preset.permissions,
    });
    await ctx.answerCallbackQuery({ text: `قالب «${preset.label}» اعمال شد.` });
    await showStaff(ctx, userId);
    await ctx.api
      .sendMessage(userId, `🛠 شما به‌عنوان «${preset.title}» به ربات اضافه شدید. دسترسی‌ها را از ادمین اصلی دریافت کرده‌اید.`)
      .catch((error) => {
        console.error("admin addition notification error:", error);
      });
  });

  bot.command("removeadmin", async (ctx) => {
    const actor = ctx.from?.id;
    if (!actor || !isOwner(actor)) return;
    const id = parseId(ctx.match);
    if (!id) return void (await ctx.reply("استفاده: /removeadmin 123456789"));
    if (id === ownerId()) return void (await ctx.reply("ادمین اصلی قابل حذف نیست."));
    await removeAdmin(id);
    await recordAdminAction(actor, "admin.remove", id);
    await ctx.api.sendMessage(id, "دسترسی ادمین شما برداشته شد.").catch((e) => {
      console.error("admin removal notification error:", e);
    });
    await ctx.reply(`🗑 ${id} از ادمین‌ها حذف شد.`);
  });

  bot.command("admins", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    const list = await listAdmins();
    await ctx.reply(
      [
        `👑 ادمین اصلی: ${ownerId()}`,
        "",
        ...(list.length
          ? list.map((admin) => `${admin.title ?? "ادمین"} · ${admin.userId} · ${admin.permissions.length} مجوز`)
          : ["ادمین فرعی‌ای وجود ندارد."]),
      ].join("\n")
    );
  });

  bot.callbackQuery("admin:audit", async (ctx) => {
    if (!(await permitted(ctx, "audit_view"))) return;
    const rows = await getDb().select().from(adminAuditLogs).orderBy(desc(adminAuditLogs.id)).limit(10);
    const text = rows.length
      ? rows.map((row) =>
          `#${row.id} · ${row.createdAt.toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}\nادمین ${row.actorId} · ${escapeHtml(row.action)}${row.targetId ? ` · هدف ${row.targetId}` : ""}`
        ).join("\n\n")
      : "هنوز اقدامی ثبت نشده است.";
    await ctx.answerCallbackQuery();
    await edit(ctx, `🧾 <b>آخرین اقدامات مدیریتی</b>\n\n${text}`, BACK);
  });

  bot.callbackQuery("admin:health", async (ctx) => {
    if (!(await permitted(ctx, "health_view"))) return;
    await ctx.answerCallbackQuery({ text: "در حال بررسی سرویس‌ها…" });
    const report = await collectHealthChecks();
    const lines = report.checks.map(({ name, result }) => {
      const icon = result.status === "ok" ? "✅" : result.status === "warning" ? "⚠️" : "❌";
      const latency = result.latencyMs === undefined ? "" : ` · ${result.latencyMs}ms`;
      return `${icon} ${name}: ${escapeHtml(result.detail)}${latency}`;
    });
    lines.push(
      "",
      `⏱ زمان فعالیت نمونه: ${Math.floor(report.runtime.uptimeSeconds / 3600)} ساعت`,
      `🕒 آخرین بررسی: ${report.runtime.checkedAt}`,
      `نسخه: ${escapeHtml(report.runtime.version)}`
    );
    await edit(
      ctx,
      `🩺 <b>سلامت سرویس‌ها</b>\n\n${lines.join("\n")}`,
      new InlineKeyboard().text("🔄 بررسی دوباره", "admin:health").row().text("🔙 بازگشت", "menu:settings")
    );
  });

  bot.callbackQuery("admin:errors", async (ctx) => {
    if (!(await permitted(ctx, "errors_view"))) return;
    const rows = await getDb()
      .select()
      .from(operationalErrors)
      .where(isNull(operationalErrors.resolvedAt))
      .orderBy(desc(operationalErrors.lastSeenAt))
      .limit(10);
    const keyboard = new InlineKeyboard();
    for (const row of rows) {
      keyboard.text(
        `🚨 ${row.source} · ${row.occurrences} بار`,
        `admin:error:${row.id}`
      ).row();
    }
    keyboard
      .text("🧹 پاک‌سازی خطاهای قدیمی", "admin:errors:cleanup")
      .row()
      .text("🔙 بازگشت", "menu:settings");
    const text = rows.length
      ? "خطاهای ثبت‌شدهٔ حل‌نشده (حداکثر ۱۰ مورد):"
      : "✅ خطای حل‌نشده‌ای ثبت نشده است.";
    await ctx.answerCallbackQuery();
    await edit(ctx, `🚨 <b>خطاهای مهم</b>\n\n${text}`, keyboard);
  });

  bot.callbackQuery(/^admin:error:(\d+)$/, async (ctx) => {
    if (!(await permitted(ctx, "errors_view"))) return;
    const [row] = await getDb()
      .select()
      .from(operationalErrors)
      .where(eq(operationalErrors.id, Number(ctx.match[1])));
    if (!row) return void (await ctx.answerCallbackQuery({ text: "خطا پیدا نشد." }));
    const keyboard = new InlineKeyboard()
      .text("✅ علامت‌گذاری به‌عنوان حل‌شده", `admin:error:resolve:${row.id}`)
      .row()
      .text("⬅️ فهرست خطاها", "admin:errors");
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      [
        `🚨 <b>${escapeHtml(row.source)}</b> · ${escapeHtml(row.severity)}`,
        `تکرار: ${row.occurrences}`,
        `اولین رخداد: ${row.firstSeenAt.toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}`,
        `آخرین رخداد: ${row.lastSeenAt.toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}`,
        "",
        escapeHtml(row.message),
      ].join("\n"),
      keyboard
    );
  });

  bot.callbackQuery(/^admin:error:resolve:(\d+)$/, async (ctx) => {
    if (!(await permitted(ctx, "errors_view"))) return;
    const id = Number(ctx.match[1]);
    const rows = await getDb()
      .update(operationalErrors)
      .set({ resolvedAt: new Date() })
      .where(and(eq(operationalErrors.id, id), isNull(operationalErrors.resolvedAt)))
      .returning({ id: operationalErrors.id });
    if (rows.length) await recordAdminAction(ctx.from.id, "operational_error.resolve", id);
    await ctx.answerCallbackQuery({ text: rows.length ? "حل‌شده ثبت شد." : "این مورد قبلاً بسته شده." });
    await edit(ctx, "✅ خطا به‌عنوان حل‌شده ثبت شد.", new InlineKeyboard().text("⬅️ خطاها", "admin:errors"));
  });

  bot.callbackQuery("admin:errors:cleanup", async (ctx) => {
    if (!(await permitted(ctx, "errors_view"))) return;
    const result = await getDb().execute(sql`
      delete from operational_errors
      where last_seen_at < now() - interval '30 days'
    `);
    await recordAdminAction(ctx.from.id, "operational_errors.cleanup", null, {
      deleted: result.count ?? 0,
    });
    await ctx.answerCallbackQuery({ text: "خطاهای قدیمی پاک‌سازی شدند." });
    await edit(
      ctx,
      `🧹 پاک‌سازی کامل شد. موارد حذف‌شده: ${result.count ?? 0}`,
      new InlineKeyboard().text("⬅️ خطاها", "admin:errors")
    );
  });

  bot.callbackQuery("admin:export", async (ctx) => {
    if (!(await permitted(ctx, "export_data"))) return;
    const keyboard = new InlineKeyboard()
      .text("📄 کاربران CSV", "admin:export:users-csv")
      .text("🧾 کاربران JSON", "admin:export:users-json")
      .row()
      .text("📊 آمار تجمیعی JSON", "admin:export:analytics")
      .row()
      .text("🛡 راهنمای پشتیبان‌گیری", "admin:backup:guide")
      .row()
      .text("🔙 بازگشت", "menu:settings");
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      "📤 <b>خروجی و پشتیبان‌گیری</b>\n\nفایل کاربران شناسه و اطلاعات هویتی مستقیم ندارد؛ شناسهٔ هر کاربر با HMAC ناشناس‌سازی می‌شود. فایل‌ها به همین گفت‌وگوی خصوصی ارسال می‌شوند.",
      keyboard
    );
  });

  bot.callbackQuery(/^admin:export:(users-csv|users-json|analytics)$/, async (ctx) => {
    if (!(await permitted(ctx, "export_data"))) return;
    await ctx.answerCallbackQuery({ text: "در حال آماده‌سازی فایل…" });
    const kind = ctx.match[1] as "users-csv" | "users-json" | "analytics";
    const output = await buildAdminExport(kind);
    if (Buffer.byteLength(output.content, "utf8") > 10 * 1024 * 1024) {
      await ctx.reply("فایل از سقف ۱۰ مگابایت بیشتر شد؛ تعداد کاربران را محدود کنید یا خروجی را از Supabase بگیرید.");
      return;
    }
    await ctx.api.sendDocument(
      ctx.from.id,
      new InputFile(Buffer.from(output.content, "utf8"), output.filename),
      { caption: `${output.description}${kind.startsWith("users-") ? "\nسقف خروجی: ۱۰٬۰۰۰ کاربر اول." : ""}` }
    );
    await recordAdminAction(ctx.from.id, "data.export", null, { kind });
  });

  bot.callbackQuery("admin:backup:guide", async (ctx) => {
    if (!(await permitted(ctx, "export_data"))) return;
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      [
        "🛡 <b>پشتیبان‌گیری و بازیابی امن</b>",
        "",
        "۱) در Supabase از بخش Database → Backups وضعیت و زمان‌بندی پشتیبان‌گیری پلن خود را بررسی کنید.",
        "۲) برای خروجی دستی، از ابزار رسمی pg_dump با connection string محافظت‌شده استفاده کنید؛ فایل را در مخزن یا چت عمومی قرار ندهید.",
        "۳) فایل پشتیبان را در فضای رمزگذاری‌شده و با دسترسی محدود نگه دارید.",
        "۴) بازیابی را ابتدا روی یک پروژهٔ جداگانه آزمایش کنید؛ بازیابی پایگاه اصلی ممکن است داده‌های جدید را بازنویسی کند.",
        "",
        "این بات پشتیبان خام نمی‌سازد و بازیابی خودکار انجام نمی‌دهد؛ عملیات بازیابی فقط از داشبورد Supabase یا ابزار عملیاتی کنترل‌شده انجام شود.",
      ].join("\n"),
      BACK
    );
  });

  bot.callbackQuery("admin:sticker", async (ctx) => {
    if (!(await permitted(ctx, "sticker_manage"))) return;
    await ctx.answerCallbackQuery();
    const uid = ctx.from.id;
    await clearMode(uid);
    const current = await getThinkingSticker();
    if (current) await ctx.replyWithSticker(current);
    else await ctx.reply("استیکری تنظیم نشده؛ به‌جایش 🔎 نمایش داده می‌شود.");
    await setPendingSticker(uid);
    await ctx.reply("استیکر جدید بفرست یا از دکمه‌ها استفاده کن.", {
      reply_markup: new InlineKeyboard()
        .text("🗑 بازنشانی به 🔎", "admin:sticker:reset")
        .row()
        .text("❌ انصراف", "admin:sticker:cancel"),
    });
  });

  bot.callbackQuery("admin:sticker:cancel", async (ctx) => {
    if (!(await permitted(ctx, "sticker_manage"))) return;
    await takePendingSticker(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "لغو شد" });
    await showSettings(ctx);
  });

  bot.callbackQuery("admin:sticker:reset", async (ctx) => {
    if (!(await permitted(ctx, "sticker_manage"))) return;
    await takePendingSticker(ctx.from.id);
    await clearThinkingSticker();
    await recordAdminAction(ctx.from.id, "sticker.reset");
    await ctx.answerCallbackQuery({ text: "استیکر بازنشانی شد." });
    await showSettings(ctx);
  });

  bot.on("message:sticker", async (ctx, next) => {
    if (!(await takePendingSticker(ctx.from.id))) return next();
    if (!(await hasAdminPermission(ctx.from.id, "sticker_manage"))) return;
    await setThinkingSticker(ctx.message.sticker.file_id);
    await recordAdminAction(ctx.from.id, "sticker.update");
    await ctx.reply("✅ استیکر پردازش ذخیره شد.");
  });

  bot.callbackQuery("admin:maintenance", async (ctx) => {
    if (!(await permitted(ctx, "maintenance_manage"))) return;
    const enabled = await getMaintenanceMode();
    const next = !enabled;
    await setMaintenanceMode(next);
    await recordAdminAction(ctx.from.id, "maintenance.toggle", null, { enabled: next });
    await ctx.answerCallbackQuery({ text: next ? "حالت تعمیرات فعال شد." : "حالت تعمیرات غیرفعال شد." });
    await edit(
      ctx,
      `🛠 <b>حالت تعمیرات</b>\nوضعیت: ${next ? "فعال" : "غیرفعال"}\n\nدر حالت تعمیرات کاربران عادی پیام اطلاع‌رسانی می‌گیرند و ادمین‌ها همچنان می‌توانند از بات استفاده کنند.`,
      new InlineKeyboard()
        .text(next ? "✅ خاموش‌کردن" : "⏸ روشن‌کردن", "admin:maintenance")
        .row()
        .text("🔙 بازگشت", "menu:settings")
    );
  });

  bot.callbackQuery("admin:features", async (ctx) => {
    if (!(await permitted(ctx, "features_manage"))) return;
    const keyboard = new InlineKeyboard();
    const states = await Promise.all(MANAGED_FEATURES.map(async (feature) => ({
      feature,
      enabled: await isFeatureEnabled(feature.key),
    })));
    for (const { feature, enabled } of states) {
      keyboard.text(`${enabled ? "✅" : "⏸"} ${feature.label}`, `admin:feature:${feature.key}`).row();
    }
    keyboard.text("🔙 بازگشت", "menu:settings");
    await ctx.answerCallbackQuery();
    await edit(ctx, "🎛 <b>وضعیت قابلیت‌ها</b>\nبرای تغییر وضعیت روی هر مورد بزن.", keyboard);
  });

  bot.callbackQuery(/^admin:feature:([a-z]+)$/, async (ctx) => {
    if (!(await permitted(ctx, "features_manage"))) return;
    const feature = MANAGED_FEATURES.find((item) => item.key === ctx.match[1]);
    if (!feature) return void (await ctx.answerCallbackQuery());
    const enabled = !(await isFeatureEnabled(feature.key));
    await setFeatureEnabled(feature.key, enabled);
    await recordAdminAction(ctx.from.id, "feature.toggle", null, { feature: feature.key, enabled });
    await ctx.answerCallbackQuery({ text: enabled ? "قابلیت فعال شد." : "قابلیت غیرفعال شد." });
    const keyboard = new InlineKeyboard();
    for (const item of MANAGED_FEATURES) {
      const isEnabled = await isFeatureEnabled(item.key);
      keyboard.text(`${isEnabled ? "✅" : "⏸"} ${item.label}`, `admin:feature:${item.key}`).row();
    }
    keyboard.text("🔙 بازگشت", "menu:settings");
    await edit(ctx, "🎛 <b>وضعیت قابلیت‌ها</b>", keyboard);
  });

  bot.callbackQuery("admin:rate", async (ctx) => {
    if (!(await permitted(ctx, "rate_limit_manage"))) return;
    const settings = await getAdminRateLimit();
    const redisConfigured = Boolean(
      (process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL) &&
      (process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN)
    );
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      `⏱ <b>محدودیت نرخ عمومی</b>\nوضعیت فعلی: ${settings.limit} پیام در ${settings.windowSeconds} ثانیه.\nUpstash Redis: ${redisConfigured ? "تنظیم شده" : "تنظیم نشده؛ محدودیت اعمال نمی‌شود"}.\n\nمقادیر جدید را به‌شکل «تعداد ثانیه» بفرست، مثل 10 5.`,
      new InlineKeyboard().text("✏️ تغییر محدودیت", "admin:rate:set").row().text("🔙 بازگشت", "menu:settings")
    );
  });

  bot.callbackQuery("admin:rate:set", async (ctx) => {
    if (!(await permitted(ctx, "rate_limit_manage"))) return;
    await ctx.answerCallbackQuery();
    await promptInput(ctx, "تعداد پیام و بازه به ثانیه را بفرست؛ مثلا 10 5.", { kind: "rate" });
  });

  bot.callbackQuery("admin:feedback", async (ctx) => {
    if (!(await permitted(ctx, "feedback_manage"))) return;
    await ctx.answerCallbackQuery();
    await showFeedback(ctx);
  });

  bot.callbackQuery(/^admin:feedback:item:(\d+)$/, async (ctx) => {
    if (!(await permitted(ctx, "feedback_manage"))) return;
    await ctx.answerCallbackQuery();
    await showFeedbackItem(ctx, Number(ctx.match[1]));
  });

  bot.callbackQuery(/^admin:feedback:close:(\d+)$/, async (ctx) => {
    if (!(await permitted(ctx, "feedback_manage"))) return;
    const id = Number(ctx.match[1]);
    const rows = await getDb()
      .update(feedback)
      .set({ status: "resolved", handledBy: ctx.from.id, handledAt: new Date() })
      .where(and(eq(feedback.id, id), eq(feedback.status, "pending")))
      .returning({ id: feedback.id });
    if (rows.length) await recordAdminAction(ctx.from.id, "feedback.resolve", id);
    await ctx.answerCallbackQuery({ text: rows.length ? "بازخورد بسته شد." : "قبلاً بسته شده است." });
    await showFeedback(ctx);
  });
}
