import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { s3Enabled, isMediaName, getMediaObject } from '../lib/storage.js';

// Serves /uploads/<name> from the S3 bucket when S3_BUCKET is set (see lib/storage.js).
// Mounted after express.static, so a file still on local disk is served from there first.
// Public and unauthenticated, exactly like the express.static uploads it stands in for:
// platforms fetch these URLs, and the names are unguessable UUIDs.
const router = Router();

const PASSTHROUGH_HEADERS = {
  ContentType: 'Content-Type',
  ContentLength: 'Content-Length',
  ContentRange: 'Content-Range',
  ETag: 'ETag',
  LastModified: 'Last-Modified',
};

router.get(
  '/:name',
  asyncHandler(async (req, res, next) => {
    if (!s3Enabled() || !isMediaName(req.params.name)) return next();

    let object;
    try {
      object = await getMediaObject(req.params.name, req.headers.range);
    } catch (err) {
      if (err.$metadata?.httpStatusCode === 416) return res.status(416).end();
      throw err;
    }
    if (!object) return next();

    for (const [field, header] of Object.entries(PASSTHROUGH_HEADERS)) {
      if (object[field] != null) {
        res.set(header, field === 'LastModified' ? object[field].toUTCString() : String(object[field]));
      }
    }
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'public, max-age=604800');
    res.status(object.ContentRange ? 206 : 200);

    if (req.method === 'HEAD') {
      object.Body.destroy?.();
      return res.end();
    }
    res.on('close', () => object.Body.destroy?.());
    object.Body.on('error', (err) => {
      req.log.error({ err }, 'media stream from S3 failed');
      res.destroy(err);
    });
    object.Body.pipe(res);
  })
);

export default router;
