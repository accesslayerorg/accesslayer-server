/**
 * Builds a standardized 422 Unprocessable Entity validation error response body.
 *
 * Use this helper wherever a validation error needs a structured response shape
 * that identifies the offending field and error code.
 *
 * @example
 * res.status(422).json(buildValidationError('wallet_address', 'Invalid Stellar address', 'INVALID_ADDRESS'));
 */
export interface ValidationErrorResponse {
    error: {
        code: string;
        field: string;
        message: string;
    };
}

export function buildValidationError(
    field: string,
    message: string,
    code: string
): ValidationErrorResponse {
    return {
        error: {
            code,
            field,
            message,
        },
    };
}
