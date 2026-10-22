// Instagram's API only accepts JPEG feed photos between 4:5 (portrait) and 1.91:1 (landscape)
// and rejects anything else outright. fitForInstagram() makes any photo acceptable without
// cropping it: the whole image is centred on a blurred, darkened copy of itself stretched to
// the nearest allowed shape, then saved as JPEG. Only Instagram gets the fitted copy; every
// other platform still receives the original file.

export const IG_MIN_RATIO = 4 / 5;
export const IG_MAX_RATIO = 1.91;
// Instagram stores feed photos at most 1440px wide, so anything larger is just upload weight.
const IG_MAX_WIDTH = 1440;
// Slack so a photo already cropped to exactly 4:5 or 1.91:1 isn't refitted over a rounding error.
const RATIO_TOLERANCE = 0.005;

let sharpPromise;
// Lazy, like getStripe(): the native library only loads when a photo actually needs fitting.
function loadSharp() {
  sharpPromise ??= import('sharp').then((m) => m.default);
  return sharpPromise;
}

// Returns a JPEG Buffer Instagram will accept, or null when the original already qualifies.
// Throws if the bytes aren't an image sharp can read (the caller then sends the original).
export async function fitForInstagram(input) {
  const sharp = await loadSharp();
  const { format } = await sharp(input).metadata();
  // .rotate() with no angle applies the EXIF orientation, so a sideways phone photo is
  // measured (and output) the way it's meant to be seen.
  const { data, info } = await sharp(input).rotate().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const ratio = width / height;
  const shapeOk = ratio >= IG_MIN_RATIO - RATIO_TOLERANCE && ratio <= IG_MAX_RATIO + RATIO_TOLERANCE;

  if (shapeOk && format === 'jpeg') return null;
  if (shapeOk) return sharp(data).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();

  let canvasWidth = width;
  let canvasHeight = height;
  if (ratio < IG_MIN_RATIO) canvasWidth = Math.ceil(height * IG_MIN_RATIO);
  else canvasHeight = Math.ceil(width / IG_MAX_RATIO);

  const scale = Math.min(1, IG_MAX_WIDTH / canvasWidth);
  const fgWidth = Math.round(width * scale);
  const fgHeight = Math.round(height * scale);
  canvasWidth = Math.max(fgWidth, Math.round(canvasWidth * scale));
  canvasHeight = Math.max(fgHeight, Math.round(canvasHeight * scale));

  const foreground = await sharp(data).resize(fgWidth, fgHeight).toBuffer();
  const background = await sharp(data)
    .flatten({ background: '#ffffff' })
    .resize(canvasWidth, canvasHeight, { fit: 'cover' })
    .blur(30)
    .modulate({ brightness: 0.7 })
    .toBuffer();

  return sharp(background)
    .composite([{ input: foreground, gravity: 'centre' }])
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
}
