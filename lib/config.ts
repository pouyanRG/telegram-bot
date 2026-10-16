export const LIMITS = {
  anon: 10,
  assistant: 10,
  persona: 10,
  voice: 5,
  news: 3,
} as const;

export type Feature = keyof typeof LIMITS;
