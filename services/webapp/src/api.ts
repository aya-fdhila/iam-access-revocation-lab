export const validationModes = ["local", "introspection", "cached"] as const;
export type ValidationMode = (typeof validationModes)[number];

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly latencyMs = 0,
  ) {
    super(message);
  }
}

export type ApiResult<T> = { data: T; status: number; latencyMs: number };

export async function apiRequestDetailed<T>(
  mode: ValidationMode,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`https://api.localhost/${mode}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiRequestError(
      0,
      "The API could not be reached. Check that the local stack is running.",
      performance.now() - started,
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new ApiRequestError(
      response.status,
      body?.error?.message ?? `Request failed with ${response.status}.`,
      performance.now() - started,
    );
  }
  const data = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  return { data, status: response.status, latencyMs: performance.now() - started };
}

export async function apiRequest<T>(
  mode: ValidationMode,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  return (await apiRequestDetailed<T>(mode, path, token, init)).data;
}
