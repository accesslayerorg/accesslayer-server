/**
 * Standard body shape for public creator list success payloads
 * (typically nested under `data` via {@link sendSuccess}).
 *
 * `meta` holds route-specific pagination or list metadata (offset-based, page-based, etc.).
 */
export type PublicCreatorListEnvelope<TItem, TMeta> = {
   items: TItem[];
   meta: TMeta;
   searchTerm?: string;
};

/**
 * Wraps list results and metadata in a single predictable object for public list routes.
 * Coerces null/undefined items to an empty array so the envelope is always well-formed.
 */
export function wrapPublicCreatorListResponse<TItem, TMeta>(
   items: TItem[] | null | undefined,
   meta: TMeta,
   searchTerm?: string
): PublicCreatorListEnvelope<TItem, TMeta> {
   const envelope: PublicCreatorListEnvelope<TItem, TMeta> = {
      items: items ?? [],
      meta,
   };
   if (searchTerm !== undefined) {
      envelope.searchTerm = searchTerm;
   }
   return envelope;
}
