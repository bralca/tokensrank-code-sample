import Link from 'next/link';
import { Brand } from './components/dashboard/Brand';
export default function NotFound() {
  return <main className="dashboard dash-auth"><section className="dash-auth-card flex flex-col gap-6">
    <Brand /><div><p className="dash-eyebrow">404</p><h1>Page not found</h1><p className="dash-subtitle">This address doesn’t lead to a TokensRank page.</p></div>
    <Link href="/" className="dash-button primary">Back to leaderboard</Link>
  </section></main>;
}
