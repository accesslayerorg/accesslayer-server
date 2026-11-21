// src/docs/registry.ts
// OpenAPI registry: registers existing zod request schemas and the response
// schemas for every documented route (#1224).
//
// `extendZodWithOpenApi(z)` must run before any `.openapi()` call, so it is
// the first statement after the imports in this module. This module must not
// import `config.ts` (or anything that parses env eagerly) so the spec can be
// generated deterministically without a populated environment.

import { z } from 'zod';
import {
   extendZodWithOpenApi,
   OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { CreateUserWithPasswordSchema } from '../modules/auth/auth.schemas';
import {
   GetNonceQuerySchema,
   ConsumeNonceBodySchema,
} from '../modules/nonce/nonce.schemas';
import {
   groupedSearchQuerySchema,
   searchPaginationQuerySchema,
} from '../modules/search/search.schemas';
import { CreatorListQuerySchema } from '../modules/creators/creators.schemas';
import { StellarAddressSchema } from '../modules/wallet/wallet.schemas';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

export const TAGS = {
   auth: 'Auth',
   nonce: 'Nonce',
   search: 'Search',
   creators: 'Creators',
} as const;

export const WALLET_AUTH_SECURITY_SCHEME = 'walletAuth';

registry.registerComponent('securitySchemes', WALLET_AUTH_SECURITY_SCHEME, {
   type: 'http',
   scheme: 'bearer',
   bearerFormat: 'JWT',
   description:
      "Wallet-scoped JWT. Obtain a token via the Stellar challenge flow and send it as `Authorization: Bearer <token>`. The token carries the caller's Stellar wallet address.",
});

// ── Shared envelopes (mirror src/utils/api-response.utils.ts) ────────────────

const ErrorResponseSchema = registry.register(
   'ErrorResponse',
   z.object({
      success: z.literal(false),
      requestId: z.string().optional(),
      error: z.object({
         code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
         message: z.string(),
         details: z
            .array(
               z.object({
                  field: z.string().optional(),
                  message: z.string(),
               })
            )
            .optional(),
      }),
   })
);

function successEnvelope<T extends z.ZodTypeAny>(data: T) {
   return z.object({
      success: z.literal(true),
      data,
      message: z.string().optional(),
   });
}

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
   'application/json': { schema },
});

function errorResponse(description: string) {
   return { description, content: jsonContent(ErrorResponseSchema) };
}

// ── Response schemas (mirror the controllers' `sendSuccess` payloads) ────────

const NonceInfoSchema = registry.register(
   'NonceInfo',
   z.object({
      wallet: StellarAddressSchema,
      nonce: z.number().int(),
      cached: z.boolean(),
   })
);

const ConsumeNonceResultSchema = registry.register(
   'ConsumeNonceResult',
   z.object({
      wallet: StellarAddressSchema,
      consumedNonce: z.number().int(),
      nextNonce: z.number().int(),
   })
);

const StellarChallengeBodySchema = registry.register(
   'StellarChallengeRequest',
   z.object({ wallet_address: StellarAddressSchema })
);

const StellarChallengeResultSchema = registry.register(
   'StellarChallengeResult',
   z.object({
      transaction: z
         .string()
         .describe('Base64 XDR of the server-signed challenge transaction'),
      server_public_key: z.string(),
      network_passphrase: z.string(),
   })
);

const RegisterResultSchema = registry.register(
   'RegisterResult',
   z.object({
      success: z.boolean(),
      message: z.string(),
      data: z
         .object({
            user: z.record(z.unknown()),
            tokens: z.object({
               accessToken: z.string(),
               refreshToken: z.string(),
            }),
         })
         .optional(),
   })
);

const SearchKeyResultSchema = registry.register(
   'SearchKeyResult',
   z.object({
      keyId: z.string(),
      keyAddress: z.string().nullable(),
      name: z.string(),
      symbol: z.string(),
      description: z.string().nullable(),
      imageUrl: z.string().nullable(),
      creatorName: z.string().nullable(),
      creatorHandle: z.string().nullable(),
      creatorAvatarUrl: z.string().nullable(),
      currentPrice: z.string().nullable(),
      holderCount: z.number().int(),
      deprecated: z.boolean(),
   })
);

const SearchCreatorResultSchema = registry.register(
   'SearchCreatorResult',
   z.object({
      id: z.string(),
      handle: z.string(),
      displayName: z.string(),
      bio: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      isVerified: z.boolean(),
      walletAddress: z.string().nullable(),
      followersCount: z.number().int(),
   })
);

const SearchTransactionResultSchema = registry.register(
   'SearchTransactionResult',
   z.object({
      txHash: z.string(),
      source: z.enum(['contract', 'trade']),
      operation: z.string(),
      status: z.string().nullable(),
      creatorId: z.string().nullable(),
      wallet: z.string().nullable(),
      ledger: z.number().int().nullable(),
      timestamp: z.string().nullable(),
   })
);

const GroupedSearchResponseSchema = registry.register(
   'GroupedSearchResponse',
   z.object({
      query: z.string(),
      keys: z.array(SearchKeyResultSchema),
      creators: z.array(SearchCreatorResultSchema),
      transactions: z.array(SearchTransactionResultSchema),
   })
);

function searchPage<T extends z.ZodTypeAny>(name: string, item: T) {
   return registry.register(
      name,
      z.object({
         items: z.array(item),
         nextCursor: z.string().nullable(),
         hasMore: z.boolean(),
         limit: z.number().int(),
      })
   );
}

const KeySearchPageSchema = searchPage('KeySearchPage', SearchKeyResultSchema);
const CreatorSearchPageSchema = searchPage(
   'CreatorSearchPage',
   SearchCreatorResultSchema
);

const CreatorListItemSchema = registry.register(
   'CreatorListItem',
   z.object({
      id: z.string(),
      name: z.string().nullable(),
      avatar: z.string().nullable(),
      followers: z.number().int(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      currentPrice: z
         .string()
         .nullable()
         .describe('Current key price in stroops; null before the first trade'),
      price24hAgo: z.string().nullable(),
      priceChange24h: z.number().nullable(),
      deprecated: z.boolean(),
   })
);

const CreatorListResponseSchema = registry.register(
   'CreatorListResponse',
   z.object({
      items: z.array(CreatorListItemSchema),
      meta: z.object({
         limit: z.number().int(),
         offset: z.number().int(),
         total: z.number().int(),
         hasMore: z.boolean(),
         searchTerm: z.string().optional(),
      }),
   })
);

// ── Routes ───────────────────────────────────────────────────────────────────

registry.registerPath({
   method: 'post',
   path: '/auth/challenge',
   tags: [TAGS.auth],
   summary: 'Request a Stellar wallet-auth challenge',
   request: {
      body: {
         required: true,
         content: jsonContent(StellarChallengeBodySchema),
      },
   },
   responses: {
      200: {
         description: 'Server-signed challenge transaction',
         content: jsonContent(successEnvelope(StellarChallengeResultSchema)),
      },
      422: errorResponse('Invalid Stellar wallet_address'),
   },
});

registry.registerPath({
   method: 'post',
   path: '/auth/register',
   tags: [TAGS.auth],
   summary: 'Register a user with email and password',
   request: {
      body: {
         required: true,
         content: jsonContent(CreateUserWithPasswordSchema),
      },
   },
   responses: {
      201: {
         description: 'User created, or a neutral "check your email" reply',
         content: jsonContent(RegisterResultSchema),
      },
      400: errorResponse('Request body failed validation'),
   },
});

registry.registerPath({
   method: 'get',
   path: '/nonce',
   tags: [TAGS.nonce],
   summary: 'Get the current nonce for a wallet',
   request: { query: GetNonceQuerySchema },
   responses: {
      200: {
         description: 'Current wallet nonce',
         content: jsonContent(successEnvelope(NonceInfoSchema)),
      },
      400: errorResponse('Invalid query parameters'),
   },
});

registry.registerPath({
   method: 'post',
   path: '/nonce/consume',
   tags: [TAGS.nonce],
   summary: 'Record consumption of a wallet nonce',
   request: {
      body: { required: true, content: jsonContent(ConsumeNonceBodySchema) },
   },
   responses: {
      200: {
         description: 'Nonce consumed',
         content: jsonContent(successEnvelope(ConsumeNonceResultSchema)),
      },
      400: errorResponse('Invalid body or nonce mismatch'),
      409: errorResponse('Nonce already consumed'),
   },
});

registry.registerPath({
   method: 'get',
   path: '/search',
   tags: [TAGS.search],
   summary: 'Grouped search overlay results',
   request: { query: groupedSearchQuerySchema },
   responses: {
      200: {
         description: 'Top keys, creators and the best transaction match',
         content: jsonContent(successEnvelope(GroupedSearchResponseSchema)),
      },
      400: errorResponse('Invalid search query'),
   },
});

registry.registerPath({
   method: 'get',
   path: '/search/keys',
   tags: [TAGS.search],
   summary: 'Search keys (cursor paginated)',
   request: { query: searchPaginationQuerySchema },
   responses: {
      200: {
         description: 'A page of key results',
         content: jsonContent(successEnvelope(KeySearchPageSchema)),
      },
      400: errorResponse('Invalid search query or cursor'),
   },
});

registry.registerPath({
   method: 'get',
   path: '/search/creators',
   tags: [TAGS.search],
   summary: 'Search creators (cursor paginated)',
   request: { query: searchPaginationQuerySchema },
   responses: {
      200: {
         description: 'A page of creator results',
         content: jsonContent(successEnvelope(CreatorSearchPageSchema)),
      },
      400: errorResponse('Invalid search query or cursor'),
   },
});

registry.registerPath({
   method: 'get',
   path: '/creators',
   tags: [TAGS.creators],
   summary: 'List creators',
   request: { query: CreatorListQuerySchema },
   responses: {
      200: {
         description: 'A page of creators with offset pagination metadata',
         content: jsonContent(successEnvelope(CreatorListResponseSchema)),
      },
      400: errorResponse('Invalid query parameters'),
   },
});
