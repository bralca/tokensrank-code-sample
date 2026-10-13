import { ArrowRight, Laptop } from 'lucide-react';
import { getLocalAppUrl } from '../../../lib/local-app-url';
import { CreateLocalPublishCodeButton } from '../../me/dashboard-actions';

export function LocalConnectionCard() {
  return <section className="dash-card dash-connect-card" aria-labelledby="connect-local-heading">
    <div className="dash-connect-heading"><span className="dash-connect-icon"><Laptop size={23} /></span><div><p className="dash-eyebrow">YOUR USAGE → YOUR SHARING RECEIPT</p><h2 id="connect-local-heading">Continue in your local app</h2><p className="dash-subtitle">A guided flow takes you through private calculations, account connection and the exact summary you choose to publish.</p></div></div>
    <div className="publish-actions"><a className="dash-button primary" href={getLocalAppUrl('/local/publish')}>Review & publish <ArrowRight size={15} /></a><a className="dash-button" href="/join">Set up the local app</a></div>
    <details className="publish-advanced"><summary>Manual connection fallback</summary><p>Use this only if the connection window in your local app cannot open.</p><CreateLocalPublishCodeButton /></details>
  </section>;
}
