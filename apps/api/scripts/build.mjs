import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const { dependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: ['src/server.ts'], outfile: 'dist/index.js', bundle: true,
  platform: 'node', format: 'esm', target: 'node20', sourcemap: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  // Workspace TypeScript is bundled; installed runtime dependencies stay external.
  external: Object.keys(dependencies).filter((name) => !name.startsWith('@tokensrank/')),
});
