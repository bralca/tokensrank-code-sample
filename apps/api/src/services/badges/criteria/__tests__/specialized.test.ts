import { describe, expect, it } from 'vitest';

import { evaluateBadge } from '../../../badge-evaluator';
import { evaluateDefectionArc } from '../defection_arc';
import { evaluateOutageWitness } from '../outage_witness';
import { evaluateTwoTool } from '../two_tool';
import { profileFixture, sessionFixture } from './fixtures';

describe('specialized badge criteria', () => {
  describe('evaluateTwoTool', () => {
    it('passes when both source values are present', () => {
      const result = evaluateTwoTool(profileFixture, [
        sessionFixture({ source: 'claude' }),
        sessionFixture({ source: 'codex' }),
      ], [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.sources).toEqual(['claude', 'codex']);
    });

    it('fails when one source is missing', () => {
      const result = evaluateTwoTool(profileFixture, [
        sessionFixture({ source: 'codex' }),
      ], [], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.has_claude).toBe(false);
    });
  });

  describe('evaluateOutageWitness', () => {
    it('passes when a session has a fraud signal error tag', () => {
      const result = evaluateOutageWitness(profileFixture, [
        sessionFixture({
          session_id: 'error-session',
          fraud_signals_json: { error_tag: 'api_5xx' },
        }),
      ], [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.error_tag).toBe('api_5xx');
      expect(result.evidence.session_id).toBe('error-session');
    });

    it('fails when no error tag exists', () => {
      const result = evaluateOutageWitness(profileFixture, [
        sessionFixture({ fingerprint: { status: 'ok' } }),
      ], [], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.has_error_tag).toBe(false);
    });
  });

  describe('evaluateDefectionArc', () => {
    it('passes when Claude activity is followed by later Codex activity', () => {
      const result = evaluateDefectionArc(profileFixture, [
        sessionFixture({ source: 'claude', first_event_at: '2026-04-01T00:00:00.000Z' }),
        sessionFixture({ source: 'codex', first_event_at: '2026-04-02T00:00:00.000Z' }),
      ], [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.transitioned).toBe(true);
    });

    it('fails when Codex activity occurs before Claude only', () => {
      const result = evaluateDefectionArc(profileFixture, [
        sessionFixture({ source: 'codex', first_event_at: '2026-04-01T00:00:00.000Z' }),
        sessionFixture({ source: 'claude', first_event_at: '2026-04-02T00:00:00.000Z' }),
      ], [], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.transitioned).toBe(false);
    });

    it('infers source from model names when source fields are missing', () => {
      const result = evaluateDefectionArc(profileFixture, [
        sessionFixture({
          source: null,
          model: 'claude-3-5-sonnet',
          first_event_at: '2026-04-01T00:00:00.000Z',
        }),
        sessionFixture({
          source: null,
          model: 'gpt-5-codex',
          first_event_at: '2026-04-02T00:00:00.000Z',
        }),
      ], [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.evaluated_sessions).toBe(2);
    });
  });

  describe('evaluateBadge dispatcher', () => {
    it('dispatches a known badge and returns award evidence', () => {
      const result = evaluateBadge(profileFixture, [
        sessionFixture({ total_tokens: 25_000_000 }),
      ], [], {
        slug: 'tier',
        requires_verification: true,
        criteria_json: {},
      });

      expect(result.awarded).toBe(true);
      expect(result.reason).toBe('awarded');
      expect(result.evidence.tokens_total).toBe(25_000_000);
    });

    it('blocks verification-gated badges for self-reported profiles before evaluation', () => {
      const result = evaluateBadge({
        ...profileFixture,
        mode: 'self_reported',
      }, [
        sessionFixture({ total_tokens: 25_000_000 }),
      ], [], {
        slug: 'tier',
        requires_verification: true,
        criteria_json: {},
      });

      expect(result.awarded).toBe(false);
      expect(result.reason).toBe('verification_gated');
      expect(result.evidence.profile_mode).toBe('self_reported');
    });

    it('returns validator_not_found for unknown badge slugs', () => {
      const result = evaluateBadge(profileFixture, [], [], {
        slug: 'unknown_badge',
        requires_verification: false,
        criteria_json: {},
      });

      expect(result.awarded).toBe(false);
      expect(result.reason).toBe('validator_not_found');
    });
  });
});
