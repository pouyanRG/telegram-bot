import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { anonState } from "./schema";

// کسی که بیشتر از این در صف مانده، دیگر برای اتصال در نظر گرفته نمی‌شود
const WAIT_MINUTES = 10;

export type JoinResult =
  | { status: "chatting"; partnerId: number }
  | { status: "waiting" }
  | { status: "matched"; partnerId: number };

export async function joinQueue(me: number): Promise<JoinResult> {
  return getDb().transaction(async (tx) => {
    const [cur] = await tx.select().from(anonState).where(eq(anonState.userId, me));
    if (cur?.state === "chatting" && cur.partnerId) {
      return { status: "chatting", partnerId: cur.partnerId };
    }
    if (cur) await tx.delete(anonState).where(eq(anonState.userId, me)); // صف قدیمی

    // یک نفر منتظر را اتمیک بردار (skip locked: دو نفر همزمان یک نفر را نمی‌گیرند)
    const rows = (await tx.execute(sql`
      update anon_state a
         set state = 'chatting', partner_id = ${me}::bigint, updated_at = now()
       where a.user_id = (
         select user_id from anon_state
          where state = 'waiting'
            and user_id <> ${me}::bigint
            and updated_at > now() - make_interval(mins => ${WAIT_MINUTES}::int)
          order by updated_at
          limit 1
          for update skip locked
       )
      returning a.user_id
    `)) as unknown as { user_id: string | number }[];

    if (rows.length > 0) {
      const partnerId = Number(rows[0].user_id);
      await tx.insert(anonState).values({ userId: me, state: "chatting", partnerId });
      return { status: "matched", partnerId };
    }

    await tx.insert(anonState).values({ userId: me, state: "waiting" });
    return { status: "waiting" };
  });
}

export type LeaveResult =
  | { was: "none" }
  | { was: "waiting" }
  | { was: "chatting"; partnerId: number | null };

/** خروج از صف یا پایان چت؛ طرف مقابل هم آزاد می‌شود */
export async function leaveChat(me: number): Promise<LeaveResult> {
  return getDb().transaction(async (tx) => {
    const [cur] = await tx.delete(anonState).where(eq(anonState.userId, me)).returning();
    if (!cur) return { was: "none" };
    if (cur.state === "waiting") return { was: "waiting" };
    if (cur.partnerId) {
      await tx
        .delete(anonState)
        .where(and(eq(anonState.userId, cur.partnerId), eq(anonState.partnerId, me)));
    }
    return { was: "chatting", partnerId: cur.partnerId };
  });
}

export async function getAnon(me: number) {
  const [r] = await getDb().select().from(anonState).where(eq(anonState.userId, me));
  if (!r) return null;
  return { state: r.state as "waiting" | "chatting", partnerId: r.partnerId };
}