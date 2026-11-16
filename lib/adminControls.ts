import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { cache } from "./schema";

export const MANAGED_FEATURES = [
  { key: "voice", label: "ویس به متن" },
  { key: "coin", label: "جستجوی ارز" },
  { key: "news", label: "اخبار روز" },
] as const;

export type ManagedFeature = (typeof MANAGED_FEATURES)[number]["key"];

type RuntimeSetting = { value: unknown; expiresAt: number };
const runtimeCache = new Map<string, RuntimeSetting>();
const CACHE_MS = 5000;

async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const cached = runtimeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  const [row] = await getDb().select({ data: cache.data }).from(cache).where(eq(cache.key, key));
  const value = (row?.data as { value?: T } | undefined)?.value ?? fallback;
  runtimeCache.set(key, { value, expiresAt: Date.now() + CACHE_MS });
  return value;
}

async function setSetting(key: string, value: unknown) {
  const data = { value };
  await getDb()
    .insert(cache)
    .values({ key, data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
  runtimeCache.set(key, { value, expiresAt: Date.now() + CACHE_MS });
}

export async function getMaintenanceMode() {
  return getSetting("admin:maintenance", false);
}

export async function setMaintenanceMode(enabled: boolean) {
  await setSetting("admin:maintenance", enabled);
}

export async function isFeatureEnabled(feature: ManagedFeature) {
  return getSetting(`admin:feature:${feature}`, true);
}

export async function setFeatureEnabled(feature: ManagedFeature, enabled: boolean) {
  await setSetting(`admin:feature:${feature}`, enabled);
}

export type RateLimitSettings = { limit: number; windowSeconds: number };

export async function getAdminRateLimit(): Promise<RateLimitSettings> {
  const value = await getSetting<RateLimitSettings>("admin:rate_limit", {
    limit: 10,
    windowSeconds: 5,
  });
  if (
    !Number.isInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 100 ||
    !Number.isInteger(value.windowSeconds) ||
    value.windowSeconds < 1 ||
    value.windowSeconds > 60
  ) {
    return { limit: 10, windowSeconds: 5 };
  }
  return value;
}

export async function setAdminRateLimit(settings: RateLimitSettings) {
  if (
    !Number.isInteger(settings.limit) ||
    settings.limit < 1 ||
    settings.limit > 100 ||
    !Number.isInteger(settings.windowSeconds) ||
    settings.windowSeconds < 1 ||
    settings.windowSeconds > 60
  ) {
    throw new Error("Invalid rate limit settings");
  }
  await setSetting("admin:rate_limit", settings);
}
