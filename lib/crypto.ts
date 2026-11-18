import { eq, like } from "drizzle-orm";
import { getDb } from "./db";
import { cache } from "./schema";

export type CryptoCoin = { id: string; name: string; symbol: string };
export type PriceAlert = {
  id: string;
  coin: CryptoCoin;
  direction: "above" | "below";
  price: number;
};
export type PendingPriceAlert = { coin: CryptoCoin; direction: PriceAlert["direction"] };
type StoredPendingPriceAlert = PendingPriceAlert & { expiresAt: number };

const watchlistKey = (userId: number) => `crypto:watchlist:${userId}`;
const pendingKey = (userId: number) => `crypto:pending:${userId}`;
const alertKey = (userId: number, alertId: string) => `crypto:alert:${userId}:${alertId}`;

async function readValue<T>(key: string, fallback: T): Promise<T> {
  const [row] = await getDb().select().from(cache).where(eq(cache.key, key));
  return (row?.data as { value?: T } | undefined)?.value ?? fallback;
}

async function writeValue(key: string, value: unknown) {
  const data = { value };
  await getDb()
    .insert(cache)
    .values({ key, data })
    .onConflictDoUpdate({ target: cache.key, set: { data, updatedAt: new Date() } });
}

export async function getWatchlist(userId: number): Promise<CryptoCoin[]> {
  return readValue(watchlistKey(userId), []);
}

export async function toggleWatchlist(userId: number, coin: CryptoCoin) {
  const coins = await getWatchlist(userId);
  const exists = coins.some((item) => item.id === coin.id);
  if (!exists && coins.length >= 20) return null;
  const next = exists ? coins.filter((item) => item.id !== coin.id) : [...coins, coin];
  await writeValue(watchlistKey(userId), next);
  return !exists;
}

export async function getPendingPriceAlert(userId: number) {
  const pending = await readValue<StoredPendingPriceAlert | null>(pendingKey(userId), null);
  if (!pending) return null;
  if (pending.expiresAt <= Date.now()) {
    await clearPendingPriceAlert(userId);
    return null;
  }
  return { coin: pending.coin, direction: pending.direction };
}

export async function setPendingPriceAlert(userId: number, value: PendingPriceAlert) {
  await writeValue(pendingKey(userId), { ...value, expiresAt: Date.now() + 10 * 60 * 1000 });
}

export async function clearPendingPriceAlert(userId: number) {
  await getDb().delete(cache).where(eq(cache.key, pendingKey(userId)));
}

export async function createPriceAlert(
  userId: number,
  value: Omit<PriceAlert, "id">
): Promise<PriceAlert | null> {
  if ((await getPriceAlerts(userId)).length >= 10) return null;
  const alert: PriceAlert = {
    ...value,
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  };
  await writeValue(alertKey(userId, alert.id), alert);
  return alert;
}

export async function removeWatchlistCoin(userId: number, coinId: string) {
  const coins = await getWatchlist(userId);
  await writeValue(watchlistKey(userId), coins.filter((coin) => coin.id !== coinId));
}

export async function getPriceAlerts(userId: number): Promise<PriceAlert[]> {
  const rows = await getDb().select().from(cache).where(like(cache.key, `crypto:alert:${userId}:%`));
  return rows.map((row) => (row.data as { value: PriceAlert }).value).filter(Boolean);
}

export async function getAllPriceAlerts() {
  const rows = await getDb().select().from(cache).where(like(cache.key, "crypto:alert:%"));
  return rows.flatMap((row) => {
    const match = /^crypto:alert:(\d+):/.exec(row.key);
    const alert = (row.data as { value?: PriceAlert }).value;
    const userId = match ? Number(match[1]) : NaN;
    return alert && Number.isSafeInteger(userId) && userId > 0 ? [{ userId, alert }] : [];
  });
}

export async function deletePriceAlert(userId: number, alertId: string) {
  await getDb().delete(cache).where(eq(cache.key, alertKey(userId, alertId)));
}