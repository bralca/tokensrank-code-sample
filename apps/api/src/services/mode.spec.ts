import { describe, expect, it } from 'vitest';

import {
  canEscalateMode,
  determineIngestionMode,
  validatePayloadDoesNotIncludeIngestionMode,
} from './mode';

describe('mode service', () => {
  describe('determineIngestionMode', () => {
    it('returns script_verified for the script endpoint', () => {
      expect(determineIngestionMode('script')).toBe('script_verified');
    });

    it('returns self_reported for the self-reported endpoint', () => {
      expect(determineIngestionMode('self-reported')).toBe('self_reported');
    });
  });

  describe('validatePayloadDoesNotIncludeIngestionMode', () => {
    it('allows payloads without ingestion_mode', () => {
      expect(() => validatePayloadDoesNotIncludeIngestionMode({
        model: 'claude-3-5-sonnet-20241022',
      })).not.toThrow();
    });

    it('throws when a top-level payload includes ingestion_mode', () => {
      expect(() => validatePayloadDoesNotIncludeIngestionMode({
        ingestion_mode: 'script_verified',
      })).toThrow('ingestion_mode is determined by endpoint');
    });

    it('throws when a nested session includes ingestion_mode', () => {
      expect(() => validatePayloadDoesNotIncludeIngestionMode({
        sessions: [
          {
            session_id: 'session-1',
            ingestion_mode: 'self_reported',
          },
        ],
      })).toThrow('ingestion_mode is determined by endpoint');
    });
  });

  describe('canEscalateMode', () => {
    it('allows NULL to script_verified', () => {
      expect(canEscalateMode(null, 'script_verified')).toBe(true);
    });

    it('allows self_reported to script_verified', () => {
      expect(canEscalateMode('self_reported', 'script_verified')).toBe(true);
    });

    it('rejects script_verified to self_reported downgrade', () => {
      expect(canEscalateMode('script_verified', 'self_reported')).toBe(false);
    });

    it('rejects self_reported no-op', () => {
      expect(canEscalateMode('self_reported', 'self_reported')).toBe(false);
    });

    it('rejects script_verified no-op', () => {
      expect(canEscalateMode('script_verified', 'script_verified')).toBe(false);
    });
  });
});
