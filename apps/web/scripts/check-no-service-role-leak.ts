import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface BundleAuditViolation {
  filePath: string;
  lineNumber: number;
  patternName: string;
  context: string;
}

interface ForbiddenPattern {
  name: string;
  expression: RegExp;
  redactMatch: boolean;
}

const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.json']);

const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    expression: /\bSUPABASE_SERVICE_ROLE_KEY\b/g,
    redactMatch: false,
  },
  {
    name: 'SUBABASE_SERVICE_ROLE_KEY',
    expression: /\bSUBABASE_SERVICE_ROLE_KEY\b/g,
    redactMatch: false,
  },
  {
    name: 'sk_live_',
    expression: /\bsk_live_[A-Za-z0-9_-]*/g,
    redactMatch: true,
  },
  {
    name: 'sk_test_',
    expression: /\bsk_test_[A-Za-z0-9_-]*/g,
    redactMatch: true,
  },
  {
    name: 'jwt_token',
    expression: /\beyJhbGciOi[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    redactMatch: true,
  },
];

function resetPatternState(): void {
  for (const pattern of FORBIDDEN_PATTERNS) {
    pattern.expression.lastIndex = 0;
  }
}

function getLineNumber(content: string, index: number): number {
  let lineNumber = 1;

  for (let position = 0; position < index; position += 1) {
    if (content.charCodeAt(position) === 10) {
      lineNumber += 1;
    }
  }

  return lineNumber;
}

function getLineContent(content: string, index: number): string {
  const lineStart = content.lastIndexOf('\n', index) + 1;
  const lineEnd = content.indexOf('\n', index);
  return content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
}

function redactContext(line: string, match: string, pattern: ForbiddenPattern): string {
  const trimmedLine = line.trim();

  if (!pattern.redactMatch) {
    return trimmedLine;
  }

  return trimmedLine.replace(match, `[redacted:${pattern.name}]`);
}

function scanFile(filePath: string, content: string): BundleAuditViolation[] {
  const violations: BundleAuditViolation[] = [];

  for (const pattern of FORBIDDEN_PATTERNS) {
    resetPatternState();

    for (const match of content.matchAll(pattern.expression)) {
      if (match.index === undefined || match[0] === '') {
        continue;
      }

      violations.push({
        filePath,
        lineNumber: getLineNumber(content, match.index),
        patternName: pattern.name,
        context: redactContext(getLineContent(content, match.index), match[0], pattern),
      });
    }
  }

  return violations;
}

async function walkDirectory(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...await walkDirectory(entryPath));
      continue;
    }

    if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

export async function scanDirectory(dirPath: string): Promise<BundleAuditViolation[]> {
  const resolvedDir = path.resolve(dirPath);
  const dirStat = await stat(resolvedDir);

  if (!dirStat.isDirectory()) {
    throw new Error(`Bundle audit target is not a directory: ${resolvedDir}`);
  }

  const files = (await walkDirectory(resolvedDir)).sort();
  const violations: BundleAuditViolation[] = [];

  for (const filePath of files) {
    const content = await readFile(filePath, 'utf8');
    violations.push(...scanFile(filePath, content));
  }

  return violations;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const targetDir = path.resolve(process.cwd(), argv[0] ?? '.next');

  try {
    const violations = await scanDirectory(targetDir);

    if (violations.length === 0) {
      console.log(`[bundle-audit] Clean: no forbidden frontend secrets found in ${targetDir}`);
      return 0;
    }

    console.error(`[bundle-audit] Found ${violations.length} forbidden frontend secret pattern(s):`);

    for (const violation of violations) {
      console.error(
        `[bundle-audit] ${violation.filePath}:${violation.lineNumber} ` +
          `${violation.patternName} ${violation.context}`,
      );
    }

    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bundle-audit] Failed to scan ${targetDir}: ${message}`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';

if (import.meta.url === invokedPath) {
  void main().then((exitCode) => {
    process.exit(exitCode);
  });
}
