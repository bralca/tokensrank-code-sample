import type { Metadata } from 'next';
import { UsageDirectory } from '../components/dashboard/UsageDirectory';
export const metadata: Metadata = { title: 'AI models by token usage · TokensRank', description: 'Explore models by published token usage, community adoption and API-equivalent value.', alternates: { canonical: '/models' } };
export default async function ModelsPage({searchParams}: {searchParams?:Promise<Record<string,string|string[]|undefined>>}) {
  return <UsageDirectory kind="model" search={await searchParams ?? {}} />;
}
