import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Shell values win, followed by .env.local, then .env. Broken legacy symlinks
// must not prevent the valid local configuration from loading.
for (const name of ['.env.local', '.env']) {
  let contents;
  try { contents = readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8'); }
  catch (error) {
    if (['ENOENT', 'ELOOP'].includes(error.code)) continue;
    throw error;
  }
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/gu, '');
    }
  }
}
