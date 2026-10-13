import {
  getModelCounts,
  getNumericCriteria,
  type BadgeCriteriaValidator,
} from '../types';

export const DRIFTER_MIN_MODELS_USED = 8;

/**
 * Evaluates the Drifter badge: the profile has explored at least eight distinct
 * models.
 */
export const evaluateDrifter: BadgeCriteriaValidator = (_profile, sessions, _aggregates, criteria) => {
  const minModelsUsed = getNumericCriteria(criteria, 'min_models_used', DRIFTER_MIN_MODELS_USED);
  const modelCounts = getModelCounts(sessions);
  const models = Array.from(modelCounts.keys()).sort();

  return {
    earned: models.length >= minModelsUsed,
    evidence: {
      models_used: models.length,
      min_models_used: minModelsUsed,
      models,
      model_tokens: Object.fromEntries(modelCounts),
    },
  };
};
