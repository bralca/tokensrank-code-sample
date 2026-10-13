import type { Metadata } from 'next';
import { UsageDirectory } from '../components/dashboard/UsageDirectory';
export const metadata: Metadata = { title: 'AI coding tools by token usage · TokensRank', description: 'Compare published Claude Code, Codex and OpenCode usage across the TokensRank community.', alternates: { canonical: '/tools' } };
export default async function ToolsPage({searchParams}: {searchParams?:Promise<Record<string,string|string[]|undefined>>}) {
  return <UsageDirectory kind="tool" search={await searchParams ?? {}} />;
}
