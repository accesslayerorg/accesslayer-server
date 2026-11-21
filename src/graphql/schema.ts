// src/graphql/schema.ts
// Read-only GraphQL schema exposing keys, holders and trades (issue #1248).
//
// The schema intentionally exposes only a `Query` root type — no mutations
// are defined, so write operations are not reachable through this endpoint.
//
// Cursor connections follow the Relay convention:
//   connection { edges: [{ node, cursor }], pageInfo: { hasNextPage, ... } }

export const typeDefs = `
  scalar DateTime

  """
  A creator key registered on Access Layer.
  """
  type Key {
    id: ID!
    handle: String
    displayName: String
    creatorWallet: String
    status: String
    createdAt: DateTime
    updatedAt: DateTime

    trades(first: Int, after: String): TradeConnection!
    holders(first: Int, after: String): HolderConnection!
  }

  """
  A wallet that holds (or has traded) one or more keys.
  Holders are derived from trade history; there is no dedicated holders table.
  """
  type Holder {
    id: ID!
    walletAddress: String!
    totalKeysHeld: Int!
    totalTrades: Int!
    totalSpent: String

    trades(first: Int, after: String): TradeConnection!
    keys(first: Int, after: String): KeyConnection!
  }

  """
  A recorded trade (purchase) of a creator key.
  """
  type Trade {
    id: ID!
    keyId: String!
    key: Key
    holder: Holder
    buyer: String!
    quantity: String!
    price: String!
    paymentAsset: String!
    ledger: Int!
    txHash: String!
    timestamp: DateTime
    createdAt: DateTime
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  type KeyEdge {
    node: Key!
    cursor: String!
  }

  type KeyConnection {
    edges: [KeyEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type TradeEdge {
    node: Trade!
    cursor: String!
  }

  type TradeConnection {
    edges: [TradeEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type HolderEdge {
    node: Holder!
    cursor: String!
  }

  type HolderConnection {
    edges: [HolderEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type Query {
    key(id: ID!): Key
    keys(first: Int, after: String): KeyConnection!
    trades(keyId: String!, first: Int, after: String): TradeConnection!
  }
`;
