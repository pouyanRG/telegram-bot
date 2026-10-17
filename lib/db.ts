import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

let _db: ReturnType<typeof createDb> | null = null;

// با max=1 همه‌ی کوئری‌ها پشت هم صف می‌شدند؛ پیش‌فرض ۳ (با DB_POOL_MAX عوض می‌شود)
function poolSize() {
  const n = Number(process.env.DB_POOL_MAX);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 3;
}

function createDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set to connect to Supabase Postgres");
  }

  const client = postgres(databaseUrl, {
    max: poolSize(),
    prepare: false,
    connect_timeout: 5, // اگر اتصال گیر کرد، بعد از ۵ ثانیه خطا بده
    idle_timeout: 20,
  });
  return drizzle(client, { schema });
}

export function getDb() {
  return (_db ??= createDb());
}