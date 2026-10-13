import {
  type BadgeCriteriaValidator,
  type SessionSnapshot,
} from '../types';

function hasProvider(sessions: SessionSnapshot[], provider: 'claude' | 'codex'): boolean {
  return sessions.some((session) => {
    const source = session.source?.trim().toLowerCase();
    const model = session.model?.trim().toLowerCase();
    return source === provider || model?.includes(provider) === true;
  });
}

/**
 * Evaluates the Multi-Provider badge: activity exists for both Claude and
 * Codex.
 */
export const evaluateMultiProvider: BadgeCriteriaValidator = (_profile, sessions) => {
  const hasClaude = hasProvider(sessions, 'claude');
  const hasCodex = hasProvider(sessions, 'codex');

  return {
    earned: hasClaude && hasCodex,
    evidence: {
      has_claude: hasClaude,
      has_codex: hasCodex,
      sources: Array.from(new Set(sessions.map((session) => session.source).filter(Boolean))).sort(),
    },
  };
};
