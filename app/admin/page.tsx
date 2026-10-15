import { count } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";

export const dynamic = "force-dynamic";

export default async function AdminPage({
  searchParams,
}: {
  searchParams?: Promise<{ password?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const adminPassword = process.env.ADMIN_PASSWORD;
  const suppliedPassword = params.password ?? "";
  const isAuthenticated = !adminPassword || suppliedPassword === adminPassword;
  const hasWrongPassword = Boolean(adminPassword) && suppliedPassword.length > 0 && !isAuthenticated;

  if (!isAuthenticated) {
    return (
      <main style={{ maxWidth: 420, margin: "40px auto", fontFamily: "system-ui, sans-serif" }}>
        <h1>ورود به پنل مدیریت</h1>
        {hasWrongPassword && <p style={{ color: "crimson" }}>رمز عبور اشتباه است.</p>}
        <p>برای دسترسی به پنل، رمز عبور را وارد کنید.</p>
        <form action="/admin" method="GET">
          <div style={{ display: "grid", gap: 12 }}>
            <label>
              <span>رمز عبور</span>
              <input
                name="password"
                type="password"
                required
                style={{ width: "100%", padding: 10, marginTop: 8 }}
              />
            </label>
            <button type="submit" style={{ padding: "10px 16px", cursor: "pointer" }}>
              ورود
            </button>
          </div>
        </form>
      </main>
    );
  }

  let total: number | null = null;
  try {
    const [row] = await db.select({ value: count() }).from(users);
    total = row.value;
  } catch {
    total = null;
  }

  return (
    <main>
      <h1>پنل مدیریت</h1>
      <p>
        تعداد کاربران:{" "}
        {total === null ? "دیتابیس متصل نیست" : total}
      </p>
    </main>
  );
}
