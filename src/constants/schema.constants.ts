// src/constants/schema.constants.ts

/**
 * Current version of the request body schema.
 * This version should be bumped whenever there are breaking changes to the request body structure.
 */
export const REQUEST_SCHEMA_VERSION = '1.0.0';

/**
 * The response header key that carries the active request schema version.
 */
export const SCHEMA_VERSION_HEADER = 'X-Schema-Version';
