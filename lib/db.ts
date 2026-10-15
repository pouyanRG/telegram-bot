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
  });
  return drizzle(client, { schema });
}

export function getDb() {
  return (_db ??= createDb());
}