import { HANDLE_PATTERN } from '@tokensrank/shared';

export type HandleFormatValidationResult =
  | {
    valid: true;
  }
  | {
    valid: false;
    reason: 'invalid_format';
  };

export function validateHandleFormat(handle: string): HandleFormatValidationResult {
  return HANDLE_PATTERN.test(handle.trim())
    ? { valid: true }
    : {
      valid: false,
      reason: 'invalid_format',
    };
}
