// ====================================================================
// Migration script: rewrite legacy file URLs in the database to point
// at the new protected /api/files/private/... route.
//
// Before this refactor, PaymentReceipt.imageUrl and Submission.imageUrl
// could be:
//   - A MinIO URL (https://minio.../bucket/receipts/...)
//   - A legacy local URL (/api/files/receipts_2026_01_abc.jpg)
//   - A direct MinIO path (receipts/2026/01/abc.jpg)
//
// After this refactor, all private files are served through
//   /api/files/private/<objectKey>
// where <objectKey> starts with private/receipts/ or private/submissions/.
//
// This script:
//   1. Scans PaymentReceipt rows whose imageUrl does NOT already start
//      with /api/files/private/.
//   2. Scans Submission rows similarly.
//   3. Rewrites each URL to the new format, preserving the original
//      object key by remapping the legacy prefix to the new private
//      prefix.
//
// Run with:
//   npx tsx scripts/migrate-private-files.ts
//
// It is IDEMPOTENT — safe to re-run. Always back up the database first.
// ====================================================================

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("❌ DATABASE_URL is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const NEW_PREFIX = "/api/files/private/";

function isAlreadyMigrated(url: string): boolean {
  return url.startsWith(NEW_PREFIX);
}

/**
 * Convert a legacy URL into a new private object key.
 *   receipts/2026/01/abc.jpg          → private/receipts/2026/01/abc.jpg
 *   /api/files/receipts_2026_01_abc   → private/receipts/receipts_2026_01_abc
 *   https://minio/bucket/receipts/... → private/receipts/...
 *   submissions/2026/01/abc.jpg       → private/submissions/2026/01/abc.jpg
 */
function remapLegacyUrl(url: string): string | null {
  if (!url) return null;
  if (isAlreadyMigrated(url)) return null;

  // Case 1: legacy local flat name — /api/files/receipts_2026_01_abc.jpg
  // We can't recover the original slashes, so we put it under private/receipts/
  // with the flat name preserved. The file actually lives at .upload/receipts_...
  // on disk — to migrate physically as well, run scripts/migrate-local-files.sh.
  const legacyFlatMatch = url.match(/^\/api\/files\/(.+)$/);
  if (legacyFlatMatch) {
    const flat = legacyFlatMatch[1];
    if (flat.startsWith("receipts_")) return `${NEW_PREFIX}private/receipts/${flat}`;
    if (flat.startsWith("submissions_")) return `${NEW_PREFIX}private/submissions/${flat}`;
    // Unknown — leave as-is
    return null;
  }

  // Case 2: MinIO URL — strip protocol+host+bucket, remap folder
  // https://minio.example.com/taswerak-uploads/receipts/2026/01/abc.jpg
  const minioMatch = url.match(
    /^https?:\/\/[^/]+\/[^/]+\/(receipts|submissions)\/(.+)$/
  );
  if (minioMatch) {
    const [, folder, rest] = minioMatch;
    return `${NEW_PREFIX}private/${folder}/${rest}`;
  }

  // Case 3: bare object key starting with receipts/ or submissions/
  if (url.startsWith("receipts/")) {
    return `${NEW_PREFIX}private/receipts/${url.slice("receipts/".length)}`;
  }
  if (url.startsWith("submissions/")) {
    return `${NEW_PREFIX}private/submissions/${url.slice("submissions/".length)}`;
  }

  // Case 4: already starts with private/... — just prepend NEW_PREFIX
  if (url.startsWith("private/receipts/") || url.startsWith("private/submissions/")) {
    return `${NEW_PREFIX}${url}`;
  }

  // Unknown format — log and skip
  console.warn(`[migrate] skipping unknown URL format: ${url}`);
  return null;
}

async function migrateTable(tableName: "paymentReceipt" | "submission") {
  // @ts-expect-error — Prisma model access
  const rows = await prisma[tableName].findMany({
    select: { id: true, imageUrl: true },
  });
  let migrated = 0;
  let skipped = 0;
  for (const r of rows) {
    const newUrl = remapLegacyUrl(r.imageUrl);
    if (!newUrl) {
      skipped++;
      continue;
    }
    // @ts-expect-error — Prisma model access
    await prisma[tableName].update({
      where: { id: r.id },
      data: { imageUrl: newUrl },
    });
    migrated++;
  }
  console.log(`✅ ${tableName}: ${migrated} migrated, ${skipped} skipped`);
}

async function main() {
  console.log("🔄 Migrating private file URLs...");
  await migrateTable("paymentReceipt");
  await migrateTable("submission");
  console.log("🎉 Migration complete.");
}

main()
  .catch((e) => {
    console.error("❌ Migration failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
