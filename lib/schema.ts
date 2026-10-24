import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// همه‌ی ستون‌های زمانی با timezone ذخیره می‌شوند (timestamptz)
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable("users", {
  telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
  username: text("username"),
  firstName: text("first_name"),
  language: text("language"),
  gender: text("gender"),
  age: integer("age"),
  province: text("province"),
  proUntil: ts("pro_until"),
  isBanned: boolean("is_banned").default(false).notNull(),
  createdAt: ts("created_at").defaultNow().notNull(),
  lastSeenAt: ts("last_seen_at").defaultNow().notNull(),
  coins: integer("coins").default(0).notNull(),
  profileRewarded: boolean("profile_rewarded").default(false).notNull(),
  displayName: text("display_name"),
  city: text("city"),
  photoFileId: text("photo_file_id"),
  publicId: text("public_id").unique(), // برای /user_xxxxxxxx
  silent: boolean("silent").default(false).notNull(),
  followersCount: integer("followers_count").default(0).notNull(),
  followingCount: integer("following_count").default(0).notNull(),
  likesCount: integer("likes_count").default(0).notNull(),
  bio: text("bio"),
});


export const bans = pgTable("bans", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" })
    .notNull()
    .references(() => users.telegramId, { onDelete: "cascade" }),
  reason: text("reason"),
  bannedBy: text("banned_by").default("admin").notNull(),
  bannedAt: ts("banned_at").defaultNow().notNull(),
  unbannedAt: ts("unbanned_at"),
});

export const quotas = pgTable(
  "quotas",
  {
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.telegramId, { onDelete: "cascade" }),
    feature: text("feature").notNull(),
    day: text("day").notNull(),
    used: integer("used").default(0).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.feature, t.day] }),
  })
);

export const cache = pgTable("cache", {
  key: text("key").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
});

export const voiceJobs = pgTable(
  "voice_jobs",
  {
    id: serial("id").primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.telegramId, { onDelete: "cascade" }),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    messageId: integer("message_id").notNull(),
    fileUniqueId: text("file_unique_id").notNull(),
    declaredSec: integer("declared_sec").notNull(),
    billedSec: integer("billed_sec"),
    status: text("status").default("processing").notNull(),
    chargedCost: integer("charged_cost").default(0).notNull(),
    chargedDay: text("charged_day"),
    createdAt: ts("created_at").defaultNow().notNull(),
    finishedAt: ts("finished_at"),
  },
  (t) => ({
    // ضد تکرار وبهوک تلگرام
    uniqMsg: uniqueIndex("voice_jobs_chat_msg_uq").on(t.chatId, t.messageId),
    // هر کاربر حداکثر یک job در حال پردازش
    oneActive: uniqueIndex("voice_jobs_one_active_uq")
      .on(t.userId)
      .where(sql`status = 'processing'`),
    byUser: index("voice_jobs_user_idx").on(t.userId, t.createdAt),
  })
);

export const admins = pgTable("admins", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  addedBy: bigint("added_by", { mode: "number" }).notNull(),
  createdAt: ts("created_at").defaultNow().notNull(),
});


// آپدیت‌های پردازش‌شده‌ی تلگرام؛ برای جلوگیری از پردازش تکراری
export const processedUpdates = pgTable(
  "processed_updates",
  {
    updateId: bigint("update_id", { mode: "number" }).primaryKey(),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byCreated: index("processed_updates_created_idx").on(t.createdAt),
  })
);

// ---------- چت ناشناس ----------

// وضعیت چت ناشناس هر کاربر: waiting (در صف) یا chatting (وصل به partnerId)
// chatId فقط وقتی chatting است پر می‌شود و به anon_chats اشاره می‌کند
export const anonState = pgTable(
  "anon_state",
  {
    userId: bigint("user_id", { mode: "number" })
      .primaryKey()
      .references(() => users.telegramId, { onDelete: "cascade" }),
    state: text("state").notNull(),
    partnerId: bigint("partner_id", { mode: "number" }),
    chatId: integer("chat_id"),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byState: index("anon_state_state_idx").on(t.state, t.updatedAt),
  })
);

// هر چت ناشناس یک ردیف (حتی بعد از پایان می‌ماند تا حذف پیام‌ها با code ممکن باشد)
// code: همان بخش آخر /delet_chat_xxxxx
export const anonChats = pgTable(
  "anon_chats",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull().unique(),
    userA: bigint("user_a", { mode: "number" })
      .notNull()
      .references(() => users.telegramId, { onDelete: "cascade" }),
    userB: bigint("user_b", { mode: "number" })
      .notNull()
      .references(() => users.telegramId, { onDelete: "cascade" }),
    startedAt: ts("started_at").defaultNow().notNull(),
    endedAt: ts("ended_at"), // null یعنی هنوز فعال
  },
  (t) => ({
    byUserA: index("anon_chats_user_a_idx").on(t.userA),
    byUserB: index("anon_chats_user_b_idx").on(t.userB),
    byEnded: index("anon_chats_ended_idx").on(t.endedAt),
  })
);

// آیدی پیام‌های رد و بدل‌شده؛ برای «حذف پیام‌ها از هر دو طرف» (تلگرام فقط ۴۸ ساعت اجازه می‌دهد)
// userId = چتی که این پیام در آن قرار دارد (در چت خصوصی همان آیدی کاربر است)
export const anonMessages = pgTable(
  "anon_messages",
  {
    id: serial("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => anonChats.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    messageId: integer("message_id").notNull(),
    fromId: bigint("from_id", { mode: "number" }), // ← جدید
    createdAt: ts("created_at").defaultNow().notNull(),

  },
  (t) => ({
    // خواندن پیام‌های ۴۸ ساعت اخیر یک چت
    byChat: index("anon_messages_chat_idx").on(t.chatId, t.createdAt),
    // پاک‌سازی دوره‌ای در housekeeping
    byCreated: index("anon_messages_created_idx").on(t.createdAt),
  })
);

export const coinTransactions = pgTable(
  "coin_transactions",
  {
    id: serial("id").primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.telegramId, { onDelete: "cascade" }),
    amount: integer("amount").notNull(), // مثبت یا منفی
    reason: text("reason").notNull(),
    ref: text("ref"),
    balanceAfter: integer("balance_after").notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => ({
    // جلوگیری از ثبت دوباره‌ی یک تراکنش (ref=null یکتا حساب نمی‌شود، که درست است)
    uniqRef: uniqueIndex("coin_tx_user_reason_ref_uq").on(t.userId, t.reason, t.ref),
    byUser: index("coin_tx_user_idx").on(t.userId, t.id),
  })
);

// هر کاربر فقط یک بار می‌تواند یک پروفایل را لایک کند
export const profileLikes = pgTable(
  "profile_likes",
  {
    likerId: bigint("liker_id", { mode: "number" })
      .notNull()
      .references(() => users.telegramId, { onDelete: "cascade" }),
    targetId: bigint("target_id", { mode: "number" })
      .notNull()
      .references(() => users.telegramId, { onDelete: "cascade" }),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.likerId, t.targetId] }) })
);

// گزارش تخلف؛ status: pending | confirmed | rejected
// evidence: عکس‌فوری از شناسه‌ی پیام‌های چت (از دید گزارش‌دهنده)
export const reports = pgTable(
  "reports",
  {
    id: serial("id").primaryKey(),
    reporterId: bigint("reporter_id", { mode: "number" })
      .notNull()
      .references(() => users.telegramId, { onDelete: "cascade" }),
    targetId: bigint("target_id", { mode: "number" })
      .notNull()
      .references(() => users.telegramId, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    details: text("details").notNull(),
    chatId: integer("chat_id"),
    evidence: jsonb("evidence"),
    status: text("status").default("pending").notNull(),
    reviewedBy: bigint("reviewed_by", { mode: "number" }),
    reviewedAt: ts("reviewed_at"),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => ({ byStatus: index("reports_status_idx").on(t.status, t.id) })
);