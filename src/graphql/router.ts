// src/graphql/router.ts
// Express router mounting the read-only GraphQL endpoint at POST /v1/graphql
// (issue #1248). Mounted by src/app.ts under /api/v1, so the full path is
// POST /api/v1/graphql.
//
// graphql-yoga provides the schema factory; execution is driven by the
// graphql.js `graphql()` function. Validation runs explicitly first so we can
// inject custom rules (depth limit, cost limit, introspection gating) and the
// per-request DataLoader context.

import express, { Request, Response } from 'express';
import {
   graphql,
   parse,
   validate,
   specifiedRules,
   ExecutionResult,
} from 'graphql';
import { createSchema } from 'graphql-yoga';
import { typeDefs } from './schema';
import { resolvers } from './resolvers';
import { createLoaders, type GraphQLContext } from './loaders';
import {
   introspectionRule,
   maxDepthLimitRule,
   queryCostLimitRule,
} from './validation';
import { envConfig } from '../config';

const schema = createSchema({ typeDefs, resolvers });

const MAX_QUERY_DEPTH = 6;
const MAX_QUERY_COST = 1000;

/**
 * Introspection is always enabled outside of production. In production it is
 * disabled unless the caller supplies a valid `x-api-key` matching the
 * configured internal API key (same convention as internal-auth middleware).
 */
function introspectionEnabled(req: Request): boolean {
   const production =
      envConfig.MODE === 'production' || process.env.NODE_ENV === 'production';
   if (!production) return true;

   const configuredKey =
      envConfig.INTERNAL_SERVICE_KEY ||
      process.env.INDEXER_API_KEY ||
      process.env.INTERNAL_API_KEY;
   if (!configuredKey) return false;

   const header = req.headers['x-api-key'];
   const providedKey = Array.isArray(header) ? header[0] : header;
   return Boolean(providedKey) && providedKey === configuredKey;
}

const router = express.Router();

router.post(
   '/',
   express.json({ limit: envConfig.BODY_SIZE_LIMIT_DEFAULT }),
   async (req: Request, res: Response): Promise<void> => {
      const body = req.body ?? {};
      const query = body.query;
      if (typeof query !== 'string' || !query.trim()) {
         res.status(400).json({
            errors: [{ message: 'Missing GraphQL "query" in request body.' }],
         });
         return;
      }

      let document;
      try {
         document = parse(query);
      } catch (error) {
         res.status(400).json({
            errors: [
               {
                  message:
                     error instanceof Error
                        ? error.message
                        : 'Invalid GraphQL query.',
               },
            ],
         });
         return;
      }

      const context: GraphQLContext = {
         req,
         loaders: createLoaders(),
      };

      const validationErrors = validate(schema, document, [
         ...specifiedRules,
         maxDepthLimitRule(MAX_QUERY_DEPTH),
         queryCostLimitRule(MAX_QUERY_COST),
         introspectionRule({ enabled: introspectionEnabled(req) }),
      ]);

      if (validationErrors.length > 0) {
         res.json({ errors: validationErrors });
         return;
      }

      const result: ExecutionResult = await graphql({
         schema,
         source: query,
         variableValues: body.variables,
         contextValue: context,
      });

      res.json(result);
   }
);

export { router, type GraphQLContext };
export default router;
