import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..');
const ciWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const jobsBlock = ciWorkflow.slice(ciWorkflow.indexOf('\njobs:'));

function section(name: string): string {
  const match = ciWorkflow.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z0-9-]+:\\n|\\n*$)`));

  if (!match?.[1]) {
    throw new Error(`Missing CI job section: ${name}`);
  }

  return match[1];
}

describe('CI workflow matrix', () => {
  it('keeps the required CI lanes wired', () => {
    const jobIds = [...jobsBlock.matchAll(/^  ([a-z0-9-]+):$/gm)].map((match) => match[1]);

    expect(jobIds).toEqual([
      'lint',
      'typecheck',
      'build',
      'privacy',
      'unit',
      'publishing-local',
      'integration',
      'performance-acceptance',
      'e2e',
      'script-tests',
    ]);
  });

  it('runs privacy, deployment artifact, integration, and E2E deployment smoke checks', () => {
    expect(section('privacy')).toContain('pnpm privacy:check');
    expect(section('privacy')).toContain('bats packages/script/test/forbidden-keys.bats');
    expect(section('unit')).toContain('sudo apt-get install -y caddy');
    expect(section('unit')).toContain('pnpm test:unit');
    expect(section('integration')).toContain('pnpm --filter @tokensrank/api test:integration');
    expect(section('e2e')).toContain('e2e/regression/deployment-smoke.spec.ts');
    expect(section('e2e')).toContain('ADMIN_PURGE_TOKEN: ${{ secrets.ADMIN_PURGE_TOKEN }}');
    expect(section('e2e')).toContain('SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}');
  });

  it('covers API/web, POSIX, macOS, and Windows script test targets', () => {
    const performance = section('performance-acceptance');
    const scriptTests = section('script-tests');

    expect(performance).toContain('target: api-web');
    expect(performance).toContain('target: script-posix');
    expect(performance).toContain('target: script-posix-macos');
    expect(performance).toContain('target: script-windows');
    expect(scriptTests).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect(scriptTests).toContain('pnpm --filter @tokensrank/script test:posix');
    expect(scriptTests).toContain('pnpm --filter @tokensrank/script test:windows');
    expect(section('e2e')).toContain('os: [ubuntu-latest, macos-latest]');
  });
});
