import {
  getModelCounts,
  getNumericCriteria,
  type BadgeCriteriaValidator,
} from '../types';

export const SNIPER_FOCUS_RATIO_THRESHOLD = 0.9;

/**
 * Evaluates the Sniper badge: one model dominates token usage beyond the focus
 * ratio threshold.
 */
export const evaluateSniper: BadgeCriteriaValidator = (_profile, sessions, _aggregates, criteria) => {
  const focusRatioThreshold = getNumericCriteria(criteria, 'focus_ratio_threshold', SNIPER_FOCUS_RATIO_THRESHOLD);
  const modelCounts = getModelCounts(sessions);
  const modelEntries = Array.from(modelCounts.entries()).sort((a, b) => b[1] - a[1]);
  const totalModelTokens = modelEntries.reduce((sum, [, tokens]) => sum + tokens, 0);
  const [topModel, topModelTokens] = modelEntries[0] ?? [null, 0];
  const topModelRatio = totalModelTokens > 0 ? topModelTokens / totalModelTokens : 0;

  return {
    earned: topModelRatio >= focusRatioThreshold && topModel !== null,
    evidence: {
      top_model: topModel,
      top_model_tokens: topModelTokens,
      top_model_ratio: topModelRatio,
      focus_ratio_threshold: focusRatioThreshold,
      models_used: modelEntries.length,
      model_tokens: Object.fromEntries(modelEntries),
    },
  };
};
