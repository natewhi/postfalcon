import { pool } from '../db/pool.js';
import { PLATFORMS, setPlatformOverrides } from './platforms.js';

// Loads the admin's platform on/off switches (platform_settings) into lib/platforms.js's
// in-memory overrides. app.js awaits ensurePlatformSettingsLoaded() before handling requests,
// and saving a switch reloads them.

let loading = null;

export async function reloadPlatformSettings() {
  const { rows } = await pool.query('SELECT platform, enabled FROM platform_settings');
  setPlatformOverrides(rows.filter((r) => PLATFORMS[r.platform]));
}

// Loads once; a failed load is retried on the next request rather than cached.
export function ensurePlatformSettingsLoaded() {
  loading ??= reloadPlatformSettings().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

export async function savePlatformSetting(platform, enabled, userId) {
  await pool.query(
    `INSERT INTO platform_settings (platform, enabled, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (platform) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [platform, enabled, userId]
  );
  await reloadPlatformSettings();
}

// Removes the saved switch, so the platform goes back to its registry default.
export async function clearPlatformSetting(platform) {
  await pool.query('DELETE FROM platform_settings WHERE platform = $1', [platform]);
  await reloadPlatformSettings();
}
