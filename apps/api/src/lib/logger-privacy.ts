const HOME_PLACEHOLDER = '/[HOME]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return [...new Set(values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value)))];
}

function redactConfiguredHome(value: string): string {
  let redacted = value;
  const homes = uniqueValues([
    process.env.HOME,
    process.env.USERPROFILE,
  ]);

  for (const home of homes) {
    const normalizedHome = normalizePathSeparators(home).replace(/\/+$/, '');

    if (!normalizedHome) {
      continue;
    }

    redacted = normalizePathSeparators(redacted).replace(
      new RegExp(`${escapeRegExp(normalizedHome)}(?=/|$)`, 'gi'),
      HOME_PLACEHOLDER,
    );
  }

  return redacted;
}

function redactCommonHomePaths(value: string): string {
  return value
    .replace(/[A-Z]:\/Users\/[^/\s)'"`]+/gi, HOME_PLACEHOLDER)
    .replace(/\/Users\/[^/\s)'"`]+/g, HOME_PLACEHOLDER)
    .replace(/\/home\/[^/\s)'"`]+/g, HOME_PLACEHOLDER);
}

export function redactLogMessage(message: string | undefined): string | undefined {
  if (message === undefined) {
    return undefined;
  }

  return redactCommonHomePaths(redactConfiguredHome(message));
}

export function redactStackTrace(stack: string | undefined): string | undefined {
  if (stack === undefined) {
    return undefined;
  }

  return stack
    .split('\n')
    .map((line) => redactLogMessage(line) ?? line)
    .join('\n');
}
