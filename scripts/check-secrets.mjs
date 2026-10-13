import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Never print a matched value: CI logs must not become a second disclosure.
export function credentialFindings(text) {
  const findings = [];
  const rules = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
    ['supabase-secret', /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g],
    ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
    ['provider-key', /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{40,}\b/g],
  ];
  for (const [rule, pattern] of rules) {
    for (const match of text.matchAll(pattern)) {
      findings.push({ rule, line: text.slice(0, match.index).split('\n').length });
    }
  }
  for (const match of text.matchAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{10,}\b/g)) {
    try {
      const payload = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString('utf8'));
      if (['anon', 'service_role'].includes(payload.role)) {
        findings.push({ rule: 'embedded-supabase-jwt', line: text.slice(0, match.index).split('\n').length });
      }
    } catch { /* Not a JWT. */ }
  }
  return findings;
}

function main() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0');
  let checked = 0;
  const findings = [];
  for (const file of new Set(files.filter(Boolean))) {
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    if (/(^|\/)\.env(?:\.|$)/.test(file) && !/(?:^|\/)\.env\.(?:example(?:\.local)?|local\.example|production\.example)$/.test(file)) {
      findings.push({ file, rule: 'tracked-environment-file', line: 1 });
    }
    const data = readFileSync(file);
    if (data.includes(0)) continue;
    checked++;
    findings.push(...credentialFindings(data.toString('utf8')).map((finding) => ({ file, ...finding })));
  }
  if (findings.length) {
    for (const finding of findings) console.error(`${finding.file}:${finding.line} ${finding.rule} (value withheld)`);
    process.exitCode = 1;
  } else {
    console.log(`Checked ${checked} text files: no embedded keys matched the credential rules.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
