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
  proUntil: ts("pro_until"),
  isBanned: boolean("is_banned").default(false).notNull(),
  banUntil: ts("ban_until"),
  createdAt: ts("created_at").defaultNow().notNull(),
  lastSeenAt: ts("last_seen_at").defaultNow().notNull(),
});


export const bans = pgTable("bans", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" })
    .notNull()
    .references(() => users.telegramId, { onDelete: "cascade" }),
  reason: text("reason"),
  bannedBy: text("banned_by").default("admin").notNull(),
  bannedAt: ts("banned_at").defaultNow().notNull(),
  banUntil: ts("ban_until"),
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
  title: text("title"),
  permissions: jsonb("permissions").$type<string[]>().default([]).notNull(),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: serial("id").primaryKey(),
    actorId: bigint("actor_id", { mode: "number" }).notNull(),
    action: text("action").notNull(),
    targetId: bigint("target_id", { mode: "number" }),
    details: jsonb("details").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byActor: index("admin_audit_actor_idx").on(t.actorId, t.createdAt),
    byCreated: index("admin_audit_created_idx").on(t.createdAt),
  })
);

export const feedback = pgTable(
  "feedback",
  {
    id: serial("id").primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.telegramId, { onDelete: "cascade" }),
    message: text("message").notNull(),
    status: text("status").default("pending").notNull(),
    handledBy: bigint("handled_by", { mode: "number" }),
    handledAt: ts("handled_at"),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => ({ byStatus: index("feedback_status_idx").on(t.status, t.id) })
);

export const operationalErrors = pgTable(
  "operational_errors",
  {
    id: serial("id").primaryKey(),
    fingerprint: text("fingerprint").notNull().unique(),
    source: text("source").notNull(),
    severity: text("severity").default("error").notNull(),
    message: text("message").notNull(),
    occurrences: integer("occurrences").default(1).notNull(),
    firstSeenAt: ts("first_seen_at").defaultNow().notNull(),
    lastSeenAt: ts("last_seen_at").defaultNow().notNull(),
    lastNotifiedAt: ts("last_notified_at"),
    resolvedAt: ts("resolved_at"),
  },
  (t) => ({
    byLastSeen: index("operational_errors_last_seen_idx").on(t.lastSeenAt),
    bySource: index("operational_errors_source_idx").on(t.source, t.lastSeenAt),
  })
);


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

// گزارش تخلف؛ status: pending | confirmed | rejected
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
    status: text("status").default("pending").notNull(),
    reviewedBy: bigint("reviewed_by", { mode: "number" }),
    reviewedAt: ts("reviewed_at"),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => ({ byStatus: index("reports_status_idx").on(t.status, t.id) })
);