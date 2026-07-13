// ====================================================================
// Taswerak — Prisma client (legacy shim)
//
// New code should import `db` from "@/lib/db" — that module uses the
// @prisma/adapter-pg adapter which is required by Prisma 7's "client"
// engine. This shim is kept only for backward compatibility with
// routes that still import from "@/lib/prisma".
// ====================================================================

import { db } from "@/lib/db";

declare global {
  // eslint-disable-next-line no-var
  var prisma: typeof db | undefined;
}

export const prisma = global.prisma || db;

if (process.env.NODE_ENV !== "production") {
  // @ts-ignore
  global.prisma = prisma;
}
