const DEFAULT_AGOS_EFFECTIVE_MIN_INITIAL_FUND = 10;

function parsePositiveNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function isAgosConfigured(env: { AGOS_API_URL?: string; AGOS_IMAGE?: string }): boolean {
  return Boolean(env.AGOS_API_URL && env.AGOS_IMAGE);
}

export function getEffectiveAgosMinInitialFund(
  env: { AGOS_EFFECTIVE_MIN_INITIAL_FUND?: string },
  fallback = DEFAULT_AGOS_EFFECTIVE_MIN_INITIAL_FUND,
): number {
  return parsePositiveNumber(env.AGOS_EFFECTIVE_MIN_INITIAL_FUND) ?? fallback;
}

export { DEFAULT_AGOS_EFFECTIVE_MIN_INITIAL_FUND };
