# My Telegram Bot (Next.js + grammY + Neon)

## راه‌اندازی
1. `npm install`
2. فایل `.env.example` را به `.env.local` کپی و مقادیر را پر کنید
3. `ADMIN_PASSWORD` را برای دسترسی به پنل مدیریت تنظیم کنید
4. `npm run db:push`  ← ساخت جدول‌ها در Neon
5. پروژه را روی GitHub بگذارید و در Vercel ایمپورت کنید
   (Environment Variables را هم در Vercel وارد کنید)
6. بعد از دیپلوی، `APP_URL` را در `.env.local` بگذارید و اجرا کنید:
   `npm run webhook:set`

## پنل مدیریت
- صفحه `/admin` فقط با ورود به سیستم قابل دسترسی است.
- رمز عبور پنل از متغیر `ADMIN_PASSWORD` خوانده می‌شود.

## نکته
- Node.js نسخه 20 یا بالاتر لازم است.
- ربات با Webhook کار می‌کند؛ `bot.start()` را صدا نزنید.
