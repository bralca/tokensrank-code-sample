import { describe, expect, it } from 'vitest';

import { evaluateConductor } from '../conductor';
import { evaluateDrifter } from '../drifter';
import { evaluateMultiProvider } from '../multi_provider';
import { evaluateSniper } from '../sniper';
import { modelSessions, profileFixture, sessionFixture } from './fixtures';

describe('diversity badge criteria', () => {
  describe('evaluateMultiProvider', () => {
    it('passes when Claude and Codex activity are both present', () => {
      const result = evaluateMultiProvider(profileFixture, [
        sessionFixture({ source: 'claude', model: 'claude-3-5-sonnet' }),
        sessionFixture({ source: 'codex', model: 'gpt-5-codex' }),
      ], [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.has_claude).toBe(true);
      expect(result.evidence.has_codex).toBe(true);
    });

    it('fails when only one provider is present', () => {
      const result = evaluateMultiProvider(profileFixture, [
        sessionFixture({ source: 'claude', model: 'claude-3-5-sonnet' }),
      ], [], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.has_codex).toBe(false);
    });
  });

  describe('evaluateConductor', () => {
    it('passes with five distinct models', () => {
      const result = evaluateConductor(profileFixture, modelSessions(5), [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.models_used).toBe(5);
    });

    it('fails below five distinct models', () => {
      const result = evaluateConductor(profileFixture, modelSessions(4), [], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.models_used).toBe(4);
    });
  });

  describe('evaluateDrifter', () => {
    it('passes with eight distinct models', () => {
      const result = evaluateDrifter(profileFixture, modelSessions(8), [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.models_used).toBe(8);
    });

    it('fails below eight distinct models', () => {
      const result = evaluateDrifter(profileFixture, modelSessions(7), [], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.models_used).toBe(7);
    });
  });

  describe('evaluateSniper', () => {
    it('passes when one model accounts for at least 90 percent of tokens', () => {
      const result = evaluateSniper(profileFixture, [
        sessionFixture({ model: 'claude-opus', total_tokens: 90 }),
        sessionFixture({ model: 'codex-mini', total_tokens: 10 }),
      ], [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.top_model).toBe('claude-opus');
      expect(result.evidence.top_model_ratio).toBe(0.9);
    });

    it('fails when usage is split across models', () => {
      const result = evaluateSniper(profileFixture, [
        sessionFixture({ model: 'claude-opus', total_tokens: 89 }),
        sessionFixture({ model: 'codex-mini', total_tokens: 11 }),
      ], [], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.top_model_ratio).toBe(0.89);
    });
  });
});
