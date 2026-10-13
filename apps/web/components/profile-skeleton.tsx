import { LoadingSkeleton } from './loading-skeleton';
import { DashboardNav } from '../app/components/dashboard/DashboardNav';

export function ProfileSkeleton() {
  return <div className="dashboard" aria-label="Preparing profile" aria-busy="true" data-testid="profile-skeleton">
    <DashboardNav />
    <div className="dash-content">
      <div className="dash-page-title"><div><LoadingSkeleton className="h-10 w-64 max-w-full" /><LoadingSkeleton className="mt-4 h-4 w-72 max-w-full" /></div></div>
      <LoadingSkeleton className="mb-7 h-12 w-72 max-w-full" rounded="full" />
      <div className="dash-stat-grid">{[1, 2, 3, 4].map(i => <div className="dash-stat" key={i}><LoadingSkeleton className="h-4 w-20" /><LoadingSkeleton className="my-5 h-10 w-24" /><LoadingSkeleton className="h-3 w-28 max-w-full" /></div>)}</div>
      <div className="dash-overview-grid"><LoadingSkeleton className="h-80" rounded="lg" /><LoadingSkeleton className="h-80" rounded="lg" /></div>
    </div>
  </div>;
}
