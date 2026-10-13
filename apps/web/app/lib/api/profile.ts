import type {
  ProfileUpdate,
} from '../../../../../packages/shared/src/schemas';
import type {
  GenerateAccessKeyRequest,
  GenerateAccessKeyResponse,
  RevokeAccessKeyResponse,
} from '../../../../../packages/shared/src/types/access-keys';

import { ApiError, apiFetch } from './index';

export type UpdateProfileResponse = {
  data: {
    updated: boolean;
  };
};

export type GenerateAccessKeyMutationResponse = {
  data: GenerateAccessKeyResponse;
};

export type RevokeAccessKeyMutationResponse = RevokeAccessKeyResponse;

function normalizeMutationError(error: unknown): never {
  if (error instanceof ApiError) {
    throw error;
  }

  throw new ApiError('Network error. Please check your connection and try again.', 0);
}

export async function updateProfileMutation(
  input: ProfileUpdate,
): Promise<UpdateProfileResponse> {
  try {
    return await apiFetch<UpdateProfileResponse>('/api/me/profile', {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  } catch (error) {
    return normalizeMutationError(error);
  }
}

export async function generateAccessKeyMutation(
  input: GenerateAccessKeyRequest,
): Promise<GenerateAccessKeyMutationResponse> {
  try {
    return await apiFetch<GenerateAccessKeyMutationResponse>('/api/access-keys/generate', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  } catch (error) {
    return normalizeMutationError(error);
  }
}

export async function revokeAccessKeyMutation(
  keyId: string,
): Promise<RevokeAccessKeyMutationResponse> {
  try {
    return await apiFetch<RevokeAccessKeyMutationResponse>(
      `/api/access-keys/${encodeURIComponent(keyId)}`,
      {
        method: 'DELETE',
      },
    );
  } catch (error) {
    return normalizeMutationError(error);
  }
}
