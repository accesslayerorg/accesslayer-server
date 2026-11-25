// src/graphql/validation.ts
// GraphQL validation rules for the read-only GraphQL endpoint (issue #1248).
//
// - maxDepthLimitRule: rejects queries nested deeper than the configured limit.
// - queryCostLimitRule: rejects queries whose estimated field cost exceeds the limit.
// - introspectionRule: disables introspection in production unless an API key is supplied.

import { GraphQLError, Kind, ValidationContext, type ASTNode } from 'graphql';

export const MAX_QUERY_DEPTH = 6;
export const MAX_QUERY_COST = 1000;

/**
 * Rejects queries whose selection-set nesting exceeds `maxDepth`.
 * Root-level fields are depth 1; each nested object selection adds one level.
 */
export function maxDepthLimitRule(maxDepth: number = MAX_QUERY_DEPTH) {
   return (context: ValidationContext) => {
      let depth = 0;
      let maxReached = 0;

      return {
         SelectionSet: {
            enter: () => {
               depth += 1;
               maxReached = Math.max(maxReached, depth);
            },
            leave: () => {
               depth -= 1;
            },
         },
         Document: {
            leave: (node: ASTNode) => {
               if (node.kind === 'Document' && maxReached > maxDepth) {
                  context.reportError(
                     new GraphQLError(
                        `Query exceeds maximum depth of ${maxDepth} (reached ${maxReached}).`,
                        { nodes: [node] }
                     )
                  );
               }
            },
         },
      };
   };
}

/**
 * Rejects queries whose estimated execution cost exceeds `maxCost`.
 *
 * Cost model:
 *   - every requested field costs 1 point;
 *   - each `first:N` argument adds `N` points (the cost of materialising N
 *     items), uncapped so excessively large pages are rejected outright.
 *   - the total is the sum over every field in the document plus all `first`
 *     arguments.
 */
export function queryCostLimitRule(maxCost: number = MAX_QUERY_COST) {
   return (context: ValidationContext) => {
      let totalCost = 0;

      return {
         Field: {
            enter: (node: ASTNode) => {
               if (node.kind !== 'Field') return;
               totalCost += 1;

               const firstArg = node.arguments?.find(
                  arg => arg.name.value === 'first'
               );
               if (firstArg?.value?.kind === Kind.INT) {
                  const n = Number(firstArg.value.value);
                  if (Number.isFinite(n) && n > 0) {
                     totalCost += n;
                  }
               }
            },
         },
         Document: {
            leave: (node: ASTNode) => {
               if (node.kind === 'Document' && totalCost > maxCost) {
                  context.reportError(
                     new GraphQLError(
                        `Query exceeds cost limit of ${maxCost} (estimated cost: ${totalCost}).`,
                        { nodes: [node] }
                     )
                  );
               }
            },
         },
      };
   };
}

type IntrospectionOptions = {
   enabled: boolean;
};

/**
 * Blocks introspection fields (`__schema`, `__type`) when `enabled` is false.
 */
export function introspectionRule(options: IntrospectionOptions) {
   return (context: ValidationContext) => ({
      Field: {
         enter: (node: ASTNode) => {
            if (
               node.kind === 'Field' &&
               (node.name.value === '__schema' ||
                  node.name.value === '__type') &&
               !options.enabled
            ) {
               context.reportError(
                  new GraphQLError(
                     'Introspection is disabled in production. Provide a valid x-api-key header to enable it.',
                     { nodes: [node] }
                  )
               );
            }
         },
      },
   });
}
