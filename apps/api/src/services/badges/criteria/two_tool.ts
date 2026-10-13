import {
  type BadgeCriteriaValidator,
} from '../types';

/**
 * Evaluates the Two-Tool badge: the profile has used both Claude and Codex
 * sources.
 */
export const evaluateTwoTool: BadgeCriteriaValidator = (_profile, sessions) => {
  const sources = new Set(
    sessions
      .map((session) => session.source?.trim().toLowerCase())
      .filter((source): source is string => source === 'claude' || source === 'codex'),
  );
  const hasClaude = sources.has('claude');
  const hasCodex = sources.has('codex');

  return {
    earned: hasClaude && hasCodex,
    evidence: {
      has_claude: hasClaude,
      has_codex: hasCodex,
      sources: Array.from(sources).sort(),
      sessions_count: sessions.length,
    },
  };
};
