// src/modules/swaps/swaps.types.ts
// Domain and API types for atomic swaps (#1087)

export type AtomicSwapStatus = 'pending' | 'executed' | 'cancelled' | 'expired';

export interface SwapKeyAmount {
   key: string;
   amount: string;
}

export interface FormattedAtomicSwap {
   id: string;
   swapId: string;
   swap_id: string;
   proposer: string;
   proposerWallet: string;
   proposer_wallet: string;
   counterparty: string;
   counterpartyWallet: string;
   counterparty_wallet: string;
   offeredKey: string;
   offered_key: string;
   offeredAmount: string;
   offered_amount: string;
   requestedKey: string;
   requested_key: string;
   requestedAmount: string;
   requested_amount: string;
   offered: SwapKeyAmount;
   requested: SwapKeyAmount;
   status: AtomicSwapStatus;
   expiresAt: Date;
   expires_at: Date;
   expiryCountdown: number;
   expiry_countdown: number;
   isExpired: boolean;
   is_expired: boolean;
   proposedAt: Date;
   proposed_at: Date;
   executedAt?: Date | null;
   executed_at?: Date | null;
   cancelledAt?: Date | null;
   cancelled_at?: Date | null;
   ledger: number;
   txHash: string;
   tx_hash: string;
   createdAt: Date;
   created_at: Date;
   updatedAt: Date;
   updated_at: Date;
}

export interface SwapPaginationMeta {
   page: number;
   limit: number;
   totalCount: number;
   totalPages: number;
   hasNextPage: boolean;
   hasPrevPage: boolean;
   hasPreviousPage?: boolean;
   hasMore?: boolean;
   has_more?: boolean;
}

export interface PaginatedSwapsResponse {
   items: FormattedAtomicSwap[];
   total: number;
   totalCount: number;
   meta: SwapPaginationMeta;
   hasMore: boolean;
   has_more: boolean;
   length: number;
   [key: number]: FormattedAtomicSwap;
}
