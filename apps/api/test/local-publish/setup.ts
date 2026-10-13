// Standalone PostgREST has no Supabase gateway's /rest/v1 prefix.
// Keep the real client, HTTP transport, permissions, SQL functions and tables.
const restUrl = process.env.SUPABASE_URL!;
if (new URL(restUrl).hostname !== '127.0.0.1') throw new Error('Publishing tests require an isolated loopback database.');
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (typeof input === 'string' && input.startsWith(`${restUrl}/rest/v1/`)) {
    return fetchOriginal(input.replace(`${restUrl}/rest/v1/`, `${restUrl}/`), init);
  }
  return fetchOriginal(input, init);
};
