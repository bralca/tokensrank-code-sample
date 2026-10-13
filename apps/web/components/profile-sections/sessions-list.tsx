import type { ProfileSessionItem } from '../../../../packages/shared/src';

type SessionListItem = ProfileSessionItem & {
  turns?: number;
};

type SessionsListSectionProps = {
  sessions: SessionListItem[];
  className?: string;
};

function formatTokens(value: number): string {
  const normalized = Math.max(0, Math.trunc(value));

  if (normalized >= 1_000_000) {
    return `${(normalized / 1_000_000).toFixed(normalized % 1_000_000 === 0 ? 0 : 1)}M`;
  }

  if (normalized >= 1_000) {
    return `${(normalized / 1_000).toFixed(normalized % 1_000 === 0 ? 0 : 1)}K`;
  }

  return String(normalized);
}

function formatDate(value: string): string {
  const date = new Date(value);
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const year = date.getUTCFullYear();
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');

  return `${month} ${day}, ${year} ${hour}:${minute}`;
}

function modelLabel(model: string | null): string {
  return model ?? 'unknown';
}

function turnsLabel(turns: number | undefined): string {
  return String(Math.max(0, Math.trunc(turns ?? 0)));
}

export function SessionsListSection({
  sessions,
  className = '',
}: SessionsListSectionProps) {
  const sortedSessions = [...sessions]
    .sort((left, right) => new Date(right.started_at).getTime() - new Date(left.started_at).getTime())
    .slice(0, 10);

  return (
    <section
      aria-labelledby="profile-sessions-heading"
      className={className}
      data-section="sessions-list"
      data-testid="profile-section-sessions-list"
    >
      <h2 id="profile-sessions-heading" className="mb-2 text-base font-semibold text-tr-text md:mb-4">
        Sessions
      </h2>

      <div className="hidden md:block">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">
            Recent profile sessions sorted by first event time descending.
          </caption>
          <thead className="border-b border-tr-border">
            <tr>
              <th scope="col" className="py-2 pr-3 text-xs font-medium uppercase text-tr-secondary">
                Date
              </th>
              <th scope="col" className="px-3 py-2 text-xs font-medium uppercase text-tr-secondary">
                Model
              </th>
              <th scope="col" className="px-3 py-2 text-right text-xs font-medium uppercase text-tr-secondary">
                Tokens
              </th>
              <th scope="col" className="py-2 pl-3 text-right text-xs font-medium uppercase text-tr-secondary">
                Turns
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-tr-border">
            {sortedSessions.length > 0 ? (
              sortedSessions.map((session) => (
                <tr key={session.session_id}>
                  <td className="py-3 pr-3 font-mono text-sm text-tr-text">
                    {formatDate(session.started_at)}
                  </td>
                  <td className="px-3 py-3 text-sm text-tr-secondary">
                    {modelLabel(session.model)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-sm text-tr-text">
                    {formatTokens(session.tokens_total)}
                  </td>
                  <td className="py-3 pl-3 text-right font-mono text-sm text-tr-secondary">
                    {turnsLabel(session.turns)}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="py-6 text-center text-sm text-tr-secondary">
                  No sessions reported for this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2 md:hidden">
        {sortedSessions.length > 0 ? (
          sortedSessions.map((session) => (
            <article
              key={session.session_id}
              className="rounded-lg border border-tr-border bg-tr-bg p-2"
            >
              <div className="flex min-w-0 items-start justify-between gap-2">
                <p className="min-w-0 break-words font-mono text-xs text-tr-text">{formatDate(session.started_at)}</p>
                <p className="shrink-0 font-mono text-xs text-tr-accent">{formatTokens(session.tokens_total)}</p>
              </div>
              <dl className="mt-2 grid grid-cols-1 gap-2 text-sm">
                <div>
                  <dt className="text-xs uppercase text-tr-secondary">Model</dt>
                  <dd className="mt-1 break-words text-tr-text">{modelLabel(session.model)}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase text-tr-secondary">Turns</dt>
                  <dd className="mt-1 font-mono text-tr-text">{turnsLabel(session.turns)}</dd>
                </div>
              </dl>
            </article>
          ))
        ) : (
          <p className="text-sm text-tr-secondary">No sessions reported for this window.</p>
        )}
      </div>
    </section>
  );
}
