import { describe, expect, it } from 'vitest';

import {
  RESERVED_HANDLES,
  isReservedSystemHandle,
} from '../src/index.js';

describe('RESERVED_HANDLES', () => {
  it('contains the FR-13 reserved system handles once each', () => {
    expect(RESERVED_HANDLES).toHaveLength(26);
    expect(new Set(RESERVED_HANDLES).size).toBe(26);
  });

  it.each([
    ['admin', true],
    ['ADMIN', true],
    ['api', true],
    ['SIGN-UP', true],
    ['alexchen', false],
  ])('checks "%s" case-insensitively', (handle, expected) => {
    expect(isReservedSystemHandle(handle)).toBe(expected);
  });
});
