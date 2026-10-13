import { rebuildProfileSummaries } from '../services/scoring';

(async () => {
  const result = await rebuildProfileSummaries({});
  // eslint-disable-next-line no-console
  console.log('REBUILD', JSON.stringify(result));
  process.exit(0);
})().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('REBUILD_FAILED', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
