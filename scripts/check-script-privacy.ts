#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ForbiddenPattern = {
  category: 'file_paths' | 'hostnames' | 'project_names' | 'prompts_responses' | 'git_diffs' | 'tool_invocations';
  name: string;
  pattern: RegExp;
};

export type PrivacyViolation = {
  file: string;
  line: number;
  column: number;
  category: ForbiddenPattern['category'];
  pattern: string;
  source: string;
};

export type PrivacyCheckResult = {
  ok: boolean;
  violations: PrivacyViolation[];
};

export const DEFAULT_AGENT_SOURCE = 'packages/script/bin/agent.mjs';

export const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  {
    category: 'file_paths',
    name: 'absolute user file path literal',
    pattern: /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|~\/(?:Desktop|Documents|Downloads|Projects|\.claude|\.codex))/u,
  },
  {
    category: 'file_paths',
    name: 'unsafe source path introspection',
    pattern: /\b(?:process\.cwd|__dirname|__filename|import\.meta\.dirname|import\.meta\.filename)\b/u,
  },
  {
    category: 'hostnames',
    name: 'host identity access',
    pattern: /(?:\bos\.hostname\s*\(|\bhostname\s*:|(?:\.|\[['"])hostname(?:\b|['"]\]))/iu,
  },
  {
    category: 'hostnames',
    name: 'hardcoded non-production URL',
    pattern: /https?:\/\/(?!(?:api\.)?tokensrank\.ai\b)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[a-z0-9.-]+\.(?:local|internal|lan)\b)/iu,
  },
  {
    category: 'project_names',
    name: 'project or workspace identifier access',
    pattern: /(?:\.|\[['"])(?:project_name|projectName|project|workspace|repository|repo)(?:\b|['"]\])|(?:project_name|projectName|workspace|repository|repo)\s*:/u,
  },
  {
    category: 'prompts_responses',
    name: 'prompt or response content access',
    pattern: /(?:\.|\[['"])(?:content|text|thinking|prompt|response|instruction|system)(?:\b|['"]\])|(?:content|text|thinking|prompt|response|instruction|system)\s*:/iu,
  },
  {
    category: 'prompts_responses',
    name: 'chat completion content access',
    pattern: /(?:choices\s*\[|\.message\.(?:content|text)|response\.text\s*\()/iu,
  },
  {
    category: 'git_diffs',
    name: 'git metadata or diff access',
    pattern: /(?:\.|\[['"])(?:git|diff|patch|command|branch|commit)(?:\b|['"]\])|(?:git|diff|patch|command|branch|commit)\s*:/iu,
  },
  {
    category: 'git_diffs',
    name: 'git command execution',
    pattern: /(?:spawn|execFile|exec)\s*\([^)]*['"]git(?:\s|['"])/iu,
  },
  {
    category: 'tool_invocations',
    name: 'tool invocation metadata access',
    pattern: /(?:\.|\[['"])(?:tool|tools|tool_name|toolName|tool_calls|function_call)(?:\b|['"]\])|(?:tool|tools|tool_name|toolName|tool_calls|function_call)\s*:/u,
  },
];

export function checkScriptPrivacy(source: string, file = DEFAULT_AGENT_SOURCE): PrivacyCheckResult {
  const violations: PrivacyViolation[] = [];
  const lines = source.split(/\r?\n/u);

  for (const [lineIndex, line] of lines.entries()) {
    for (const forbidden of FORBIDDEN_PATTERNS) {
      const pattern = new RegExp(forbidden.pattern.source, forbidden.pattern.flags);
      const match = pattern.exec(line);
      if (!match) {
        continue;
      }

      violations.push({
        file,
        line: lineIndex + 1,
        column: match.index + 1,
        category: forbidden.category,
        pattern: forbidden.name,
        source: line.trim(),
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

async function readAndCheck(file: string): Promise<PrivacyCheckResult> {
  const source = await readFile(file, 'utf8');
  return checkScriptPrivacy(source, file);
}

function formatViolation(violation: PrivacyViolation): string {
  const file = relative(process.cwd(), violation.file) || violation.file;
  return `${file}:${violation.line}:${violation.column} [${violation.category}] ${violation.pattern}: ${violation.source}`;
}

async function runCli(files: string[]): Promise<number> {
  const targets = files.length > 0 ? files : [DEFAULT_AGENT_SOURCE];
  const violations: PrivacyViolation[] = [];

  for (const target of targets) {
    try {
      const result = await readAndCheck(target);
      violations.push(...result.violations);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[tokensrank-privacy] Failed to read ${target}: ${message}\n`);
      return 1;
    }
  }

  if (violations.length === 0) {
    process.stdout.write(`[tokensrank-privacy] Clean: ${targets.join(', ')}\n`);
    return 0;
  }

  process.stderr.write(`[tokensrank-privacy] Found ${violations.length} privacy violation(s):\n`);
  for (const violation of violations) {
    process.stderr.write(`- ${formatViolation(violation)}\n`);
  }

  return 1;
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[tokensrank-privacy] ${message}\n`);
      process.exitCode = 1;
    });
}
