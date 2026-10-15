# My Telegram Bot (Next.js + grammY + Supabase)

## راه‌اندازی
1. `npm install`
2. در Supabase یک پروژه بسازید و از بخش **Connect**، رشته اتصال PostgreSQL را بردارید. برای Vercel از **Transaction pooler** استفاده کنید.
3. فایل `.env.example` را به `.env.local` کپی و مقادیر را پر کنید؛ رشته اتصال Supabase را در `DATABASE_URL` قرار دهید.
4. `ADMIN_PASSWORD` را برای دسترسی به پنل مدیریت تنظیم کنید
5. `npm run db:push`  ← ساخت جدول‌ها در Supabase
6. پروژه را روی GitHub بگذارید و در Vercel ایمپورت کنید
   (Environment Variables را هم در Vercel وارد کنید)
7. بعد از دیپلوی، `APP_URL` را در `.env.local` بگذارید و اجرا کنید:
   `npm run webhook:set`

در Supabase مسیر **Project Settings → Database → Connect** را باز کنید و رشته **Transaction pooler** را انتخاب کنید. اگر رمز دیتابیس شامل کاراکترهای خاص است، آن را در URL encode کنید. مقدارهای واقعی را فقط در `.env.local` و تنظیمات محیطی Vercel قرار دهید؛ فایل `.env.local` را منتشر نکنید.

## پنل مدیریت
- صفحه `/admin` فقط با ورود به سیستم قابل دسترسی است.
- رمز عبور پنل از متغیر `ADMIN_PASSWORD` خوانده می‌شود.

## نکته
- Node.js نسخه 20 یا بالاتر لازم است.
- ربات با Webhook کار می‌کند؛ `bot.start()` را صدا نزنید.
