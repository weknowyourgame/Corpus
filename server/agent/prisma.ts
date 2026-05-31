import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

let prisma: PrismaClient | null = null;
let pool: pg.Pool | null = null;

export function getPrismaClient() {
  if (prisma) return prisma;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as ConstructorParameters<typeof PrismaClient>[0]);
  return prisma;
}

export async function disconnectPrisma() {
  await prisma?.$disconnect();
  await pool?.end();
  prisma = null;
  pool = null;
}
