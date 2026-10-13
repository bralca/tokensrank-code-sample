import { ReactNode } from 'react';
import { TR, FONT_MONO } from '@/lib/design-tokens';

export interface FooterStat {
  label: string;
  value: ReactNode;
  sub?: string;
  accent?: boolean;
}

/** The L0/L1-style stats row: equal columns divided by hairlines, mono numerals. */
export function StatFooter({ stats }: { stats: FooterStat[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${stats.length}, 1fr)` }}>
      {stats.map((stat, index) => (
        <div
          key={stat.label}
          style={{
            padding: '18px 22px',
            borderLeft: index > 0 ? `1px solid ${TR.border}` : 'none',
            minWidth: 0,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 500,
              color: TR.textMid,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              fontFamily: FONT_MONO,
              marginBottom: 9,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {stat.label}
          </div>
          <div
            style={{
              fontSize: 21,
              fontWeight: 600,
              color: TR.text,
              fontFamily: FONT_MONO,
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {stat.value}
          </div>
          {stat.sub && (
            <div
              style={{
                fontSize: 11,
                color: stat.accent ? TR.accent : TR.textDim,
                fontFamily: FONT_MONO,
                marginTop: 6,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {stat.sub}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Shared card shell + horizontal divider used between chart rows and the footer. */
export function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        backgroundColor: TR.bgSoft,
        border: `1px solid ${TR.border}`,
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  );
}

export function Divider() {
  return <div style={{ borderTop: `1px solid ${TR.border}` }} />;
}

/** Small uppercase label above an in-card chart row. */
export function ChartLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        fontWeight: 500,
        color: TR.textMid,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        fontFamily: FONT_MONO,
        marginBottom: 14,
      }}
    >
      {children}
    </div>
  );
}

export function ChartHeader({ children, label }: { children?: ReactNode; label: ReactNode }) {
  return (
    <div
      style={{
        alignItems: 'center',
        display: 'flex',
        gap: 12,
        justifyContent: 'space-between',
        marginBottom: 14,
        minHeight: 28,
      }}
    >
      <div
        style={{
          color: TR.textMid,
          fontFamily: FONT_MONO,
          fontSize: 10.5,
          fontWeight: 500,
          letterSpacing: '0.1em',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
      {children ? <div style={{ flexShrink: 0 }}>{children}</div> : null}
    </div>
  );
}

export function RuleSectionHeader({
  number,
  title,
  meta,
}: {
  meta?: ReactNode;
  number: string;
  title: string;
}) {
  return (
    <div
      style={{
        alignItems: 'center',
        display: 'grid',
        gap: 14,
        gridTemplateColumns: 'auto auto minmax(48px, 1fr) auto',
        marginBottom: 18,
      }}
    >
      <span
        style={{
          color: TR.accent,
          fontFamily: FONT_MONO,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.12em',
        }}
      >
        {number}
      </span>
      <span
        style={{
          color: TR.text,
          fontFamily: FONT_MONO,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </span>
      <span style={{ borderTop: `1px solid ${TR.border}` }} />
      {meta ? (
        <span
          style={{
            color: TR.textDim,
            fontFamily: FONT_MONO,
            fontSize: 11,
            letterSpacing: '0.04em',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {meta}
        </span>
      ) : null}
    </div>
  );
}
