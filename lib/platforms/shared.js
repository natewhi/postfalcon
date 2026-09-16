import fs from 'node:fs/promises';
import path from 'node:path';
import { uploadDir } from '../../middleware/upload.js';

// Meta Graph API version used by the Facebook and Instagram adapters. Kept here so the
// two stay in lockstep when it's bumped.
export const GRAPH_VERSION = 'v19.0';

// Reads an uploaded media row's file off disk. `media.url` is a full public URL
// (BASE_URL/uploads/<name>); only the basename maps to a file under uploadDir.
export async function readMediaFile(media) {
  const filePath = path.join(uploadDir, path.basename(media.url));
  return fs.readFile(filePath);
}
