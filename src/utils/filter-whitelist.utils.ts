/**
 * Validates that all keys in a raw input object are present in an allow-list.
 * Throws if any unsupported keys are found.
 *
 * @param allowedKeys - Readonly array of permitted key names
 * @param raw - Raw input object to validate (e.g. req.query subset)
 * @param label - Optional label for error messages (e.g. "creator filter")
 * @throws Error listing unsupported keys
 *
 * @example
 * rejectUnknownKeys(['verified', 'search'], { verified: 'true' });
 * // passes
 *
 * @example
 * rejectUnknownKeys(['verified', 'search'], { foo: 'bar' });
 * // throws Error: Unsupported filter key(s): foo
 */
export function rejectUnknownKeys<T extends readonly string[]>(
    allowedKeys: T,
    raw: Record<string, unknown>,
    label?: string
): void {
    const unsupported = Object.keys(raw).filter(
        key => !(allowedKeys as readonly string[]).includes(key)
    );

    if (unsupported.length > 0) {
        const prefix = label ? `Unsupported ${label} key(s)` : 'Unsupported filter key(s)';
        throw new Error(`${prefix}: ${unsupported.join(', ')}`);
    }
}
