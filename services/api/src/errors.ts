export class ApiError extends Error {
  readonly statusCode: number;
  readonly errorCode: string;
  readonly challenge: boolean;

  constructor(options: {
    statusCode: number;
    errorCode: string;
    message: string;
    challenge?: boolean;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.statusCode = options.statusCode;
    this.errorCode = options.errorCode;
    this.challenge = options.challenge ?? false;
  }
}

export function unauthenticated(message = "A valid bearer token is required."): ApiError {
  return new ApiError({
    statusCode: 401,
    errorCode: "invalid_token",
    message,
    challenge: true,
  });
}

export function forbidden(errorCode: string, message: string): ApiError {
  return new ApiError({ statusCode: 403, errorCode, message });
}

export function dependencyUnavailable(message: string): ApiError {
  return new ApiError({
    statusCode: 503,
    errorCode: "identity_dependency_unavailable",
    message,
  });
}

export function notFound(message: string): ApiError {
  return new ApiError({ statusCode: 404, errorCode: "not_found", message });
}
