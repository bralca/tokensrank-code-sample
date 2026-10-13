import { z } from 'zod';

const WebEnvSchema = z.object({
  NEXT_PUBLIC_API_BASE: z.string().min(1, 'NEXT_PUBLIC_API_BASE is required').url(),
}).strict();

export type WebEnv = z.infer<typeof WebEnvSchema>;

let cachedEnv: WebEnv | null = null;

function handleInvalidEnv(error: z.ZodError): never {
  const message = error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');

  if (typeof window === 'undefined') {
    console.error(`[web-env] Invalid environment: ${message}`);
    process.exit(1);
  }

  throw new Error(`[web-env] Invalid environment: ${message}`);
}

export function getWebEnv(): WebEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = WebEnvSchema.safeParse({
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE,
  });

  if (!parsed.success) {
    return handleInvalidEnv(parsed.error);
  }

  cachedEnv = parsed.data;

  return cachedEnv;
}

export const webEnv = new Proxy({} as WebEnv, {
  get(_target, property: keyof WebEnv) {
    return getWebEnv()[property];
  },
});
