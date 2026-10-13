import Link from 'next/link';
import { ArrowRight, FolderSearch, LockKeyhole, FileCheck2, Github } from 'lucide-react';
import { Brand, SOURCE_URL } from '../components/dashboard/Brand';
import { getLocalAppUrl } from '../../lib/local-app-url';

export default function JoinPage() {
  return <main className="dashboard publish-wizard"><header className="publish-header"><Brand /><Link href="/">Back to leaderboard</Link></header><div className="publish-container"><section className="publish-panel">
    <p className="dash-eyebrow">JOIN THE LEADERBOARD</p><h1>Start with your own numbers.</h1><p className="publish-lead">TokensRank runs on your computer to show how you use AI. Publishing is optional: you choose whether to share a summary with your public profile.</p>
    <div className="publish-boundary"><div><FolderSearch size={23} /><h3>1. Open the local app</h3><p>Discover your Claude, Codex and OpenCode usage files. No account needed to explore.</p></div><ArrowRight size={18} /><div><LockKeyhole size={23} /><h3>2. Calculate privately</h3><p>See tokens, model usage and estimated API value. Your conversations stay on your device.</p></div><ArrowRight size={18} /><div><FileCheck2 size={23} /><h3>3. Review, then publish</h3><p>Connect GitHub, inspect your sharing receipt and confirm exactly what goes public.</p></div></div>
    <h2>Run TokensRank locally</h2><p className="publish-footnote">This experimental version runs from a repository checkout. You’ll need Node.js 22 and pnpm 10.27.0.</p>
    <pre className="join-install"><code>{`git clone ${SOURCE_URL}.git tokensrank\ncd tokensrank\npnpm install --frozen-lockfile\ncp .env.local.example .env.local\nnode packages/local-cli/bin/tokensrank-local.mjs --publish`}</code></pre>
    <p className="publish-footnote">Keep the local app running while you use your dashboard. Once it starts, continue below to calculate your numbers and review a receipt.</p>
    <div className="publish-actions"><a className="dash-button primary" href={getLocalAppUrl('/local/publish')}>Open local app & continue <ArrowRight size={16} /></a><a className="dash-button" href={SOURCE_URL} target="_blank" rel="noreferrer"><Github size={16} /> View source</a></div>
    <details className="publish-advanced"><summary>What will be public?</summary><p>Your GitHub identity, daily token and session counts, model and tool usage, and estimated API value. Code contributions are optional. The local app lists every included field in a downloadable receipt before you confirm.</p><p>Conversations, prompts, commands, source files, session IDs, session timelines and local file hashes are excluded. Reading files or connecting an account does not publish them.</p></details>
  </section><footer className="publish-footer"><LockKeyhole size={14} /> Explore privately. Publish only when you’re ready.</footer></div></main>;
}
