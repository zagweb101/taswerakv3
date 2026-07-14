#!/usr/bin/env bash
# ====================================================================
# Taswerak — Automated PostgreSQL backup script
# Designed to run as a cron job inside the Coolify container or VPS.
#
# Usage:
#   bash scripts/backup-cron.sh
#
# Cron (daily at 3 AM, keep 30 days):
#   0 3 * * * /app/scripts/backup-cron.sh >> /var/log/taswerak-backup.log 2>&1
#
# Or via Coolify scheduled task:
#   Schedule: 0 3 * * *
#   Command:  bash /app/scripts/backup-cron.sh
#
# Env vars required:
#   DATABASE_URL — PostgreSQL connection string
#   BACKUP_RETENTION_DAYS — days to keep (default: 30)
#   BACKUP_DIR — where to store backups (default: /app/backups)
#
# Optional (S3 upload):
#   BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY,
#   BACKUP_S3_SECRET_KEY — if set, uploads backup to S3 after local save
# ====================================================================

set -euo pipefail

# ---------- Configuration ----------
DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
BACKUP_DIR="${BACKUP_DIR:-/app/backups}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/taswerak_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "[$(date)] Starting Taswerak PostgreSQL backup..."
echo "  Database: $(echo "$DATABASE_URL" | sed 's/\/\/.*@/\/\/***:***@/')"
echo "  Output:   $BACKUP_FILE"
echo "  Retention: $RETENTION_DAYS days"

# ---------- Step 1: pg_dump ----------
if ! command -v pg_dump &>/dev/null; then
  echo "[$(date)] ERROR: pg_dump not found. Install postgresql-client."
  exit 1
fi

echo "[$(date)] Running pg_dump..."
pg_dump "$DATABASE_URL" --no-owner --no-acl | gzip > "$BACKUP_FILE"

BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[$(date)] Backup created: $BACKUP_FILE ($BACKUP_SIZE)"

# ---------- Step 2: Verify backup (can we restore?) ----------
echo "[$(date)] Verifying backup integrity..."
if gunzip -t "$BACKUP_FILE" 2>/dev/null; then
  echo "[$(date)] ✅ Backup is valid (gzip integrity check passed)"
else
  echo "[$(date)] ❌ Backup is corrupt! Keeping it for investigation."
  exit 1
fi

# ---------- Step 3: Upload to S3 (optional) ----------
if [ -n "${BACKUP_S3_BUCKET:-}" ] && [ -n "${BACKUP_S3_ACCESS_KEY:-}" ]; then
  echo "[$(date)] Uploading to S3..."
  if command -v mc &>/dev/null; then
    mc alias set backupS3 "${BACKUP_S3_ENDPOINT:-https://s3.amazonaws.com}" \
      "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" 2>/dev/null || true
    mc cp "$BACKUP_FILE" "backupS3/${BACKUP_S3_BUCKET}/backups/$(basename "$BACKUP_FILE")" 2>/dev/null && \
      echo "[$(date)] ✅ Uploaded to S3" || \
      echo "[$(date)] ⚠️ S3 upload failed (non-fatal)"
  elif command -v aws &>/dev/null; then
    AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
    aws s3 cp "$BACKUP_FILE" "s3://${BACKUP_S3_BUCKET}/backups/$(basename "$BACKUP_FILE")" 2>/dev/null && \
      echo "[$(date)] ✅ Uploaded to S3" || \
      echo "[$(date)] ⚠️ S3 upload failed (non-fatal)"
  else
    echo "[$(date)] ⚠️ S3 configured but neither mc nor aws CLI found — skipping upload"
  fi
fi

# ---------- Step 4: Delete old backups ----------
echo "[$(date)] Cleaning up backups older than $RETENTION_DAYS days..."
DELETED=$(find "$BACKUP_DIR" -name "taswerak_*.sql.gz" -mtime +$RETENTION_DAYS -print -delete | wc -l)
echo "[$(date)] Deleted $DELETED old backup(s)"

# ---------- Step 5: Summary ----------
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
TOTAL_COUNT=$(find "$BACKUP_DIR" -name "taswerak_*.sql.gz" | wc -l)
echo "[$(date)] ✅ Backup complete."
echo "  Total backups: $TOTAL_COUNT"
echo "  Total size:    $TOTAL_SIZE"
echo "  Latest:        $BACKUP_FILE"
