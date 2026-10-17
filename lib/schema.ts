import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { sql } from "drizzle-orm";
import { index, uniqueIndex } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
  username: text("username"),
  firstName: text("first_name"),
  language: text("language"),
  proUntil: timestamp("pro_until"),
  isBanned: boolean("is_banned").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
});

export const bans = pgTable("bans", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  reason: text("reason"),
  bannedBy: text("banned_by").default("admin").notNull(),
  bannedAt: timestamp("banned_at").defaultNow().notNull(),
  unbannedAt: timestamp("unbanned_at"),
});

export const quotas = pgTable(
  "quotas",
  {
    userId: bigint("user_id", { mode: "number" }).notNull(),
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
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const voiceJobs = pgTable(
  "voice_jobs",
  {
    id: serial("id").primaryKey(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    messageId: integer("message_id").notNull(),
    fileUniqueId: text("file_unique_id").notNull(),
    declaredSec: integer("declared_sec").notNull(),
    billedSec: integer("billed_sec"),
    // processing | done | failed
    status: text("status").default("processing").notNull(),
    chargedCost: integer("charged_cost").default(0).notNull(),
    chargedDay: text("charged_day"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
});