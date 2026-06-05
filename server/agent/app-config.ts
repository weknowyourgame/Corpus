import type { Prisma } from "@prisma/client";
import { getPrismaClient } from "./prisma.ts";

const memoryConfig = new Map<string, unknown>();

export async function getAppConfigValue<T>(key: string): Promise<T | null> {
  if (!process.env.DATABASE_URL) return (memoryConfig.get(key) as T | undefined) ?? null;
  const row = await getPrismaClient().appConfig.findUnique({ where: { key } });
  return (row?.value as T | undefined) ?? null;
}

export async function setAppConfigValue<T>(key: string, value: T): Promise<T> {
  memoryConfig.set(key, value);
  if (!process.env.DATABASE_URL) return value;
  await getPrismaClient().appConfig.upsert({
    where: { key },
    update: { value: value as Prisma.InputJsonValue },
    create: { key, value: value as Prisma.InputJsonValue },
  });
  return value;
}
