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

export const users = pgTable("users", {
  telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
  username: text("username"),
  firstName: text("first_name"),
  language: text("language"),
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
