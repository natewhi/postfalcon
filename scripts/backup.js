// npm run backup — takes a database backup now (the same one scheduler.js runs nightly; see
// lib/backup.js for where it goes and how to restore). A CLI script, so it logs with console.
import dotenv from 'dotenv';

dotenv.config();
const { runBackup } = await import('../lib/backup.js');

try {
  const result = await runBackup();
  console.log(`Backup written: ${result.name} (${(result.bytes / 1024).toFixed(0)} KB)`);
  console.log(result.uploaded ? 'Uploaded to the bucket under backups/.' : 'No bucket configured: kept on this server only.');
  process.exit(0);
} catch (err) {
  console.error(`Backup failed: ${err.message}`);
  process.exit(1);
}
