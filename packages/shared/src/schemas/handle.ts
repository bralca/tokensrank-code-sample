import { z } from 'zod';

import { isReservedHandle as isReservedHandleValue } from '../constants/reserved-handles.js';

export const HANDLE_PATTERN = /^[a-z0-9_-]{3,30}$/;

export const normalizeHandle = (handle: string): string => handle.trim().toLowerCase();

export const isReservedHandle = (handle: string): boolean => isReservedHandleValue(normalizeHandle(handle));

export const HandleSchema = z
  .string()
  .trim()
  .regex(
    HANDLE_PATTERN,
    'Handle must be 3-30 characters and use only lowercase letters, numbers, underscores, and hyphens',
  )
  .refine((handle) => !isReservedHandle(handle), {
    message: 'That handle\'s reserved',
  });

export const isValidHandle = (handle: string): boolean => HandleSchema.safeParse(handle).success;

export type Handle = z.infer<typeof HandleSchema>;

export const HandleCheckReasonSchema = z.enum([
  'invalid_format',
  'reserved',
  'already_taken',
]);

export type HandleCheckReason = z.infer<typeof HandleCheckReasonSchema>;

export const HandleCheckSchema = z.object({
  h: z.string().trim(),
}).strict();

export type HandleCheckRequest = z.infer<typeof HandleCheckSchema>;

export const HandleCheckResponseDataSchema = z.object({
  available: z.boolean(),
  reason: HandleCheckReasonSchema.optional(),
}).strict();

export const HandleCheckResponseSchema = z.object({
  data: HandleCheckResponseDataSchema,
}).strict();

export type HandleCheckResponseData = z.infer<typeof HandleCheckResponseDataSchema>;
export type HandleCheckResponse = z.infer<typeof HandleCheckResponseSchema>;
