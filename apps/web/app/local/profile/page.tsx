import { ProfileWindowSchema, type ProfileWindow } from '../../../../../packages/shared/src';
import { ProfileContainer } from '../../components/profile/ProfileContainer';
import { LocalShell } from '../LocalShell';

type SearchParams = Record<string, string | string[] | undefined>;

type LocalProfilePageProps = {
  searchParams?: Promise<SearchParams>;
};

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseWindow(searchParams: SearchParams): ProfileWindow {
  const parsed = ProfileWindowSchema.safeParse(firstQueryValue(searchParams.window) ?? '30d');
  return parsed.success ? parsed.data : '30d';
}

export default async function LocalProfilePage({ searchParams }: LocalProfilePageProps) {
  const resolvedSearchParams = await Promise.resolve(searchParams ?? {});
  const window = parseWindow(resolvedSearchParams);

  return (
    <LocalShell>
      <ProfileContainer handle="local" window={window} showHeader={false} />
    </LocalShell>
  );
}
