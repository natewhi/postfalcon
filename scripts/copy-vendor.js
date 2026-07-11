import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, '../node_modules/fullcalendar/index.global.min.js');
const destDir = path.join(__dirname, '../public/vendor/fullcalendar');
const dest = path.join(destDir, 'index.global.min.js');

if (!fs.existsSync(src)) {
  console.warn('fullcalendar package not found, skipping vendor copy.');
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log('Copied FullCalendar vendor bundle to public/vendor/fullcalendar/.');
