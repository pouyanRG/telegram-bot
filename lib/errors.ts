// پیامی که عیناً به کاربر نشان داده می‌شود (متن امن و کنترل‌شده)
export class UserError extends Error {}

export function isUniqueViolation(e: unknown) {
  const x = e as { code?: string; cause?: { code?: string } };
  return x?.code === "23505" || x?.cause?.code === "23505";
}