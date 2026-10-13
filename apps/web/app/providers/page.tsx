import type { Metadata } from 'next';
import { UsageDirectory } from '../components/dashboard/UsageDirectory';
export const metadata: Metadata = { title: 'AI providers by published usage · TokensRank', description: 'Explore recorded AI provider usage by models, tools and builders.', alternates: { canonical: '/providers' } };
export default async function ProvidersPage({searchParams}: {searchParams?:Promise<Record<string,string|string[]|undefined>>}) {
  return <UsageDirectory kind="provider" search={await searchParams ?? {}} />;
}
