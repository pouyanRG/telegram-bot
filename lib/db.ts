import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

let _db: ReturnType<typeof createDb> | null = null;

function createDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set to connect to Supabase Postgres");
  }

  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 5, // اگر اتصال گیر کرد، بعد از ۵ ثانیه خطا بده
    idle_timeout: 20,
  });
  return drizzle(client, { schema });
}

export function getDb() {
  return (_db ??= createDb());
}