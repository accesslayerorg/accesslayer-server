import { CREATOR_PUBLIC_QUERY_KEYS } from "../constants/creator-public-query.constants";

export const parseCreatorPublicQuery = (query: Record<string, any>) => {
  return {
    creatorId: query[CREATOR_PUBLIC_QUERY_KEYS.CREATOR_ID],
    creatorAddress: query[CREATOR_PUBLIC_QUERY_KEYS.CREATOR_ADDRESS],
    username: query[CREATOR_PUBLIC_QUERY_KEYS.USERNAME],
  };
};
