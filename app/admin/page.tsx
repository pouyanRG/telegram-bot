import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, count, desc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { SETTINGS } from "@/lib/config";
import { bans, users } from "@/lib/schema";
import { destroyAdminSession, isAdmin } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

const PAGE_SIZE = SETTINGS.adminPageSize;

// در ilike کاراکترهای % و _ و \ معنی خاص دارند
const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

export default async function AdminPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; page?: string }>;
}) {
  if (!(await isAdmin())) redirect("/admin/login");

  const sp = (await searchParams) ?? {};
  const q = sp.q?.trim() ?? "";
  const page = Math.min(100_000, Math.max(1, Math.floor(Number(sp.page)) || 1));

  async function setBan(formData: FormData) {
    "use server";
    if (!(await isAdmin())) redirect("/admin/login");
    const id = Number(formData.get("id"));
    const ban = formData.get("ban") === "1";
    if (!Number.isSafeInteger(id)) return;

    // هر دو مرحله در یک تراکنش، تا وضعیت users و bans ناسازگار نشود
    await getDb().transaction(async (tx) => {
      const updated = await tx
        .update(users)
        .set({ isBanned: ban })
        .where(eq(users.telegramId, id))
        .returning({ id: users.telegramId });
      if (updated.length === 0) return;

      const [open] = await tx
        .select({ id: bans.id })
        .from(bans)
        .where(and(eq(bans.userId, id), isNull(bans.unbannedAt)))
        .limit(1);

      if (ban) {
        if (!open) await tx.insert(bans).values({ userId: id, reason: "manual" });
      } else {
        await tx
          .update(bans)
          .set({ unbannedAt: new Date() })
          .where(and(eq(bans.userId, id), isNull(bans.unbannedAt)));
      }
    });
    revalidatePath("/admin");
  }

  async function setPro(formData: FormData) {
    "use server";
    if (!(await isAdmin())) redirect("/admin/login");
    const id = Number(formData.get("id"));
    const days = Number(formData.get("days"));
    if (!Number.isSafeInteger(id) || !Number.isInteger(days) || days < 0 || days > 3650) return;

    await getDb()
      .update(users)
      .set({
        // days=0 یعنی لغو؛ در غیر این صورت به انتهای اشتراک فعلی اضافه می‌شود
        proUntil:
          days === 0
            ? null
            : sql`greatest(coalesce(${users.proUntil}, now()), now()) + make_interval(days => ${days}::int)`,
      })
      .where(eq(users.telegramId, id));
    revalidatePath("/admin");
  }

  async function logout() {
    "use server";
    await destroyAdminSession();
    redirect("/admin/login");
  }

  let stats: { total: number; active: number; banned: number } | null = null;
  let rows: (typeof users.$inferSelect)[] = [];
  let matched = 0;

  try {
    const db = getDb();
    const [t] = await db.select({ v: count() }).from(users);
    const [a] = await db
      .select({ v: count() })
      .from(users)
      .where(gt(users.lastSeenAt, sql`now() - interval '24 hours'`));
    const [b] = await db.select({ v: count() }).from(users).where(eq(users.isBanned, true));
    stats = { total: t.v, active: a.v, banned: b.v };

    const term = q.replace(/^@/, "");
    const asId = Number(term);
    const where = term
      ? or(
          ilike(users.username, `%${escapeLike(term)}%`),
          Number.isSafeInteger(asId) ? eq(users.telegramId, asId) : undefined
        )
      : undefined;

    const [m] = await db.select({ v: count() }).from(users).where(where);
    matched = m.v;

    rows = await db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.lastSeenAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE);
  } catch (e) {
    console.error("Admin DB error:", e);
  }

  const totalPages = Math.max(1, Math.ceil(matched / PAGE_SIZE));
  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("page", String(p));
    return `/admin?${params.toString()}`;
  };

  return (
    <main>
      <h1>پنل مدیریت</h1>
      <form action={logout}>
        <button type="submit">خروج</button>
      </form>

      {stats ? (
        <p>
          کل کاربران: {stats.total} | فعال ۲۴ ساعت اخیر: {stats.active} | مسدود: {stats.banned}
        </p>
      ) : (
        <p>دیتابیس متصل نیست</p>
      )}

      <form method="GET" action="/admin" style={{ margin: "16px 0" }}>
        <input name="q" defaultValue={q} placeholder="آیدی عددی یا یوزرنیم" />
        <button type="submit">جستجو</button>
      </form>

      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th>آیدی</th>
            <th>یوزرنیم</th>
            <th>نام</th>
            <th>آخرین فعالیت</th>
            <th>وضعیت</th>
            <th>پرو تا</th>
            <th></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.telegramId}>
              <td>{u.telegramId}</td>
              <td>{u.username ? `@${u.username}` : "—"}</td>
              <td>{u.firstName ?? "—"}</td>
              <td>{u.lastSeenAt.toISOString().slice(0, 16).replace("T", " ")}</td>
              <td>{u.isBanned ? "⛔️ مسدود" : "✅ فعال"}</td>
              <td>{u.proUntil ? u.proUntil.toISOString().slice(0, 10) : "—"}</td>
              <td>
                <form action={setPro}>
                  <input type="hidden" name="id" value={u.telegramId} />
                  <input type="hidden" name="days" value="30" />
                  <button type="submit">+۳۰ روز پرو</button>
                </form>
              </td>
              <td>
                <form action={setBan}>
                  <input type="hidden" name="id" value={u.telegramId} />
                  <input type="hidden" name="ban" value={u.isBanned ? "0" : "1"} />
                  <button type="submit">{u.isBanned ? "رفع مسدودی" : "مسدود کن"}</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ marginTop: 16 }}>
        {page > 1 ? <a href={pageHref(page - 1)}>« قبلی</a> : null}
        {page > 1 && page < totalPages ? " | " : null}
        <span style={{ margin: "0 12px" }}>
          صفحه {page} از {totalPages} ({matched} کاربر)
        </span>
        {page < totalPages ? <a href={pageHref(page + 1)}>بعدی »</a> : null}
      </p>
    </main>
  );
}