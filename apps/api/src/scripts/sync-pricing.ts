import { syncModelPricing } from '../services/models-dev-sync';

(async () => {
  const result = await syncModelPricing({});
  // eslint-disable-next-line no-console
  console.log('SYNC', JSON.stringify(result));
  process.exit(0);
})().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('SYNC_FAILED', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
