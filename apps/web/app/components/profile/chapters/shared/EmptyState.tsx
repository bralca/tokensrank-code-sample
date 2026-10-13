'use client';

import { TR, LAYOUT, SPACING } from '@/lib/design-tokens';

export type EmptyStateCondition = 'no_sessions' | 'need_7d' | 'need_2_models' | 'need_concurrent';

interface EmptyStateProps {
  condition: EmptyStateCondition;
}

export function EmptyState({ condition }: EmptyStateProps) {
  const messages: Record<EmptyStateCondition, { title: string; description: string }> = {
    no_sessions: {
      title: 'No Sessions Yet',
      description: 'Start using Claude or Codex to populate this section.',
    },
    need_7d: {
      title: 'Need 7 Days of Data',
      description: 'This metric requires at least 7 days of activity to display.',
    },
    need_2_models: {
      title: 'Need 2+ Models',
      description: 'Use at least 2 different models to see model breakdown.',
    },
    need_concurrent: {
      title: 'No Concurrent Sessions',
      description: 'Run sessions in parallel to see parallelism metrics.',
    },
  };

  const message = messages[condition];

  return (
    <div
      style={{
        padding: `${SPACING.xl}px`,
        textAlign: 'center',
        borderRadius: 8,
        backgroundColor: TR.bgSoft,
        border: `1px solid ${TR.border}`,
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 500,
          color: TR.textMid,
          marginBottom: SPACING.sm,
        }}
      >
        {message.title}
      </div>
      <div
        style={{
          fontSize: 12,
          color: TR.textDim,
          lineHeight: 1.5,
        }}
      >
        {message.description}
      </div>
    </div>
  );
}
