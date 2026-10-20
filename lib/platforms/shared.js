import path from 'node:path';
import { readMedia } from '../storage.js';

// Meta Graph API version used by the Facebook and Instagram adapters. Kept here so the
// two stay in lockstep when it's bumped.
export const GRAPH_VERSION = 'v19.0';

// Reads an uploaded media row's file (local disk or S3, see lib/storage.js). `media.url` is a
// full public URL (BASE_URL/uploads/<name>); only the basename identifies the file.
export async function readMediaFile(media) {
  return readMedia(path.basename(media.url));
}
