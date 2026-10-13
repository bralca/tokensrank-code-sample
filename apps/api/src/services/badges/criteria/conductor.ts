import {
  getModelCounts,
  getNumericCriteria,
  type BadgeCriteriaValidator,
} from '../types';

export const CONDUCTOR_MIN_MODELS_USED = 5;

/**
 * Evaluates the Conductor badge: the profile has used at least five distinct
 * models.
 */
export const evaluateConductor: BadgeCriteriaValidator = (_profile, sessions, _aggregates, criteria) => {
  const minModelsUsed = getNumericCriteria(criteria, 'min_models_used', CONDUCTOR_MIN_MODELS_USED);
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
