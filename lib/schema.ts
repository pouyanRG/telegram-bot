import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
  username: text("username"),
  firstName: text("first_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
