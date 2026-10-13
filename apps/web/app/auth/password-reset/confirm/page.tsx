import { ResetConfirmForm } from './reset-confirm-form';

type SearchParams = Record<string, string | string[] | undefined>;

type PasswordResetConfirmPageProps = {
  searchParams?: Promise<SearchParams>;
};

function getToken(searchParams: SearchParams): string {
  const token = searchParams.token;

  if (Array.isArray(token)) {
    return token[0]?.trim() ?? '';
  }

  return token?.trim() ?? '';
}

export default async function PasswordResetConfirmPage({
  searchParams,
}: PasswordResetConfirmPageProps) {
  const resolvedSearchParams = await Promise.resolve(searchParams ?? {});
  const token = getToken(resolvedSearchParams);

  return (
    <section className="flex w-full flex-col gap-8" aria-labelledby="password-reset-confirm-title">
      <header className="flex flex-col gap-2">
        <p className="font-sans text-sm font-medium text-[var(--muted)]">
          Password reset
        </p>
        <h1 id="password-reset-confirm-title" className="text-2xl font-semibold text-[var(--ink)]">
          Choose a new password
        </h1>
        <p className="text-sm leading-6 text-[var(--muted)]">
          Your new password applies to future TokensRank sign-ins.
        </p>
      </header>

      {token ? (
        <ResetConfirmForm token={token} />
      ) : (
        <div
          className="rounded-md border border-[#EF4444]/50 bg-[#EF4444]/10 px-3 py-2 text-sm leading-5 text-red-700"
          role="alert"
          data-testid="missing-reset-token"
        >
          Invalid or missing reset token.
        </div>
      )}
    </section>
  );
}
