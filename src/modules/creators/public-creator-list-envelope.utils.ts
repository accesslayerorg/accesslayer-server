/**
 * Standard body shape for public creator list success payloads
 * (typically nested under `data` via {@link sendSuccess}).
 *
 * `meta` holds route-specific pagination or list metadata (offset-based, page-based, etc.).
 */
export type PublicCreatorListEnvelope<TItem, TMeta> = {
   items: TItem[];
   meta: TMeta;
};

/**
 * Wraps list results and metadata in a single predictable object for public list routes.
 * Coerces null/undefined items to an empty array so the envelope is always well-formed.
 */
export function wrapPublicCreatorListResponse<TItem, TMeta>(
   items: TItem[] | null | undefined,
   meta: TMeta
): PublicCreatorListEnvelope<TItem, TMeta> {
   return { items: items ?? [], meta };
}
