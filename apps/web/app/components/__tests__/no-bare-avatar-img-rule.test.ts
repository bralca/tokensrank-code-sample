import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '../../..');
const ruleDirectory = path.join(webRoot, '.eslintrc-custom-rules');

function createEslint() {
  return new ESLint({
    cwd: webRoot,
    overrideConfigFile: path.join(webRoot, '.eslintrc.json'),
    overrideConfig: {
      rules: {
        'jsx-a11y/alt-text': 'off',
      },
    },
    useEslintrc: false,
  });
}

describe('no-bare-avatar-img ESLint rule', () => {
  it('reports intentional bare avatar image violations', async () => {
    const eslint = createEslint();
    const fixturePath = path.join(ruleDirectory, '__fixtures__/bare-avatar-violations.tsx');
    const code = await readFile(fixturePath, 'utf8');
    const [result] = await eslint.lintText(code, {
      filePath: path.join(webRoot, 'app/components/bare-avatar-violations.tsx'),
    });

    expect(result?.messages.map((message) => message.ruleId)).toEqual([
      'tokensrank/no-bare-avatar-img',
      'tokensrank/no-bare-avatar-img',
      'tokensrank/no-bare-avatar-img',
    ]);
  });

  it('does not report inside AvatarWithBadge itself', async () => {
    const eslint = createEslint();
    const [result] = await eslint.lintFiles([path.join(webRoot, 'app/components/avatar-with-badge.tsx')]);

    expect(result?.messages).toEqual([]);
  });

  it('allows unrelated non-avatar img tags', async () => {
    const eslint = createEslint();
    const code = await readFile(path.join(webRoot, 'components/og-card-variant-a.tsx'), 'utf8');
    const [result] = await eslint.lintText(code, {
      filePath: path.join(webRoot, 'components/og-card-variant-a.tsx'),
    });

    expect(result?.messages).toEqual([]);
  });
});
