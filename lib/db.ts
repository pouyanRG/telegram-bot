import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

let _db: ReturnType<typeof createDb> | null = null;

function createDb() {
  return drizzle(neon(process.env.DATABASE_URL!), { schema });
}

export function getDb() {
  return (_db ??= createDb());
}