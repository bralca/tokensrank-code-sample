import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../../..');

describe('AvatarWithBadge lint integration', () => {
  it('runs ESLint with the no-bare-avatar-img rule against web source', () => {
    const output = execFileSync(
      'pnpm',
      ['--filter', '@tokensrank/web', 'lint'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
      },
    );

    expect(output).toContain('@tokensrank/web');
  });
});
