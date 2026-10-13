import type { ProfileCadenceDay } from '../../../../packages/shared/src';

type CadenceHour = {
  dow: number;
  hour: number;
  tokens_total: number;
};

type CadenceHeatmapSectionProps = {
  cadence_by_dow: Array<ProfileCadenceDay | CadenceHour>;
  className?: string;
};

const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourLabels = new Map([
  [0, '12am'],
  [6, '6am'],
  [12, '12pm'],
  [18, '6pm'],
]);
const heatStops = ['#0B0E11', '#1A2410', '#2B3D14', '#476B1B', '#7BB02A', '#B6FF3C'];

function isHourlyEntry(value: ProfileCadenceDay | CadenceHour): value is CadenceHour {
  return 'dow' in value && 'hour' in value;
}

function mondayFirstDow(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

function normalizeCadence(rows: Array<ProfileCadenceDay | CadenceHour>): CadenceHour[] {
  return rows.map((row) => {
    if (isHourlyEntry(row)) {
      return {
        dow: Math.max(0, Math.min(6, Math.trunc(row.dow))),
        hour: Math.max(0, Math.min(23, Math.trunc(row.hour))),
        tokens_total: Math.max(0, Math.trunc(row.tokens_total)),
      };
    }

    return {
      dow: mondayFirstDow(new Date(row.date)),
      hour: 12,
      tokens_total: Math.max(0, Math.trunc(row.tokens_total)),
    };
  });
}

function colorFor(tokens: number, peak: number): string {
  if (tokens <= 0 || peak <= 0) {
    return heatStops[0]!;
  }

  const index = Math.min(heatStops.length - 1, Math.ceil((tokens / peak) * (heatStops.length - 1)));

  return heatStops[index]!;
}

function buildHourlyMatrix(rows: CadenceHour[]): number[][] {
  const matrix = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

  for (const row of rows) {
    matrix[row.dow]![row.hour] += row.tokens_total;
  }

  return matrix;
}

function buildMobileBuckets(matrix: number[][]): number[][] {
  return matrix.map((day) => [
    day.slice(0, 6).reduce((sum, value) => sum + value, 0),
    day.slice(6, 12).reduce((sum, value) => sum + value, 0),
    day.slice(12, 18).reduce((sum, value) => sum + value, 0),
    day.slice(18, 24).reduce((sum, value) => sum + value, 0),
  ]);
}

export function CadenceHeatmapSection({
  cadence_by_dow,
  className = '',
}: CadenceHeatmapSectionProps) {
  const hourlyRows = normalizeCadence(cadence_by_dow);
  const hourlyMatrix = buildHourlyMatrix(hourlyRows);
  const mobileMatrix = buildMobileBuckets(hourlyMatrix);
  const peak = Math.max(0, ...hourlyMatrix.flat());
  const mobilePeak = Math.max(0, ...mobileMatrix.flat());

  return (
    <section
      aria-labelledby="profile-cadence-heading"
      aria-label="Cadence heatmap by day of week and hour"
      className={className}
      data-section="cadence-heatmap"
      data-testid="profile-section-cadence-heatmap"
    >
      <h2 id="profile-cadence-heading" className="mb-2 text-base font-semibold text-tr-text md:mb-4">
        Cadence
      </h2>

      <div className="hidden md:block">
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: '2.5rem repeat(24, minmax(0, 1fr))' }}
        >
          <div aria-hidden="true" />
          {Array.from({ length: 24 }, (_, hour) => (
            <div key={hour} className="h-4 text-center text-[10px] text-tr-secondary">
              {hourLabels.get(hour) ?? ''}
            </div>
          ))}
          {days.map((day, dow) => (
            <div key={day} className="contents">
              <div className="flex h-4 items-center text-xs text-tr-secondary">{day}</div>
              {hourlyMatrix[dow]!.map((tokens, hour) => (
                <div
                  key={`${day}-${hour}`}
                  className="h-4 rounded-sm border border-tr-border"
                  style={{ backgroundColor: colorFor(tokens, peak) }}
                  title={`${day} ${hour}:00 UTC — ${tokens} tokens`}
                  role="img"
                  aria-label={`${day} ${hour}:00 UTC, ${tokens} tokens`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="block max-w-full md:hidden">
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: '2.5rem repeat(4, minmax(0, 1fr))' }}
        >
          <div aria-hidden="true" />
          {['12am', '6am', '12pm', '6pm'].map((label) => (
            <div key={label} className="text-center text-[10px] text-tr-secondary">
              {label}
            </div>
          ))}
          {days.map((day, dow) => (
            <div key={day} className="contents">
              <div className="flex h-7 items-center text-xs text-tr-secondary">{day}</div>
              {mobileMatrix[dow]!.map((tokens, bucket) => (
                <div
                  key={`${day}-${bucket}`}
                  className="h-7 rounded-sm border border-tr-border"
                  style={{ backgroundColor: colorFor(tokens, mobilePeak) }}
                  title={`${day} ${bucket * 6}:00 UTC bucket — ${tokens} tokens`}
                  role="img"
                  aria-label={`${day} six hour bucket ${bucket + 1}, ${tokens} tokens`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
