export const CREATOR_PUBLIC_QUERY_KEYS = {
  CREATOR_ID: "creatorId",
  CREATOR_ADDRESS: "creatorAddress",
  USERNAME: "username",
} as const;

export type CreatorPublicQueryKey =
  (typeof CREATOR_PUBLIC_QUERY_KEYS)[keyof typeof CREATOR_PUBLIC_QUERY_KEYS];