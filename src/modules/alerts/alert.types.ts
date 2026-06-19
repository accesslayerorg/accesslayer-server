export type AlertDirectionName = 'above' | 'below';

export interface CreateAlertInput {
  creatorId: string;
  walletAddress: string;
  targetPrice: string;
  direction: AlertDirectionName;
  callbackUrl: string;
}

export interface AlertResponse {
  id: string;
  creatorId: string;
  walletAddress: string;
  targetPrice: string;
  direction: AlertDirectionName;
  callbackUrl: string;
  status: 'pending' | 'triggered' | 'failed';
  createdAt: Date;
}

export interface AlertTriggerPayload {
  creator_id: string;
  triggered_price: string;
  target_price: string;
  direction: AlertDirectionName;
  timestamp: string;
}

/**
 * Minimal trade-event shape required to evaluate price-alert thresholds.
 *
 * Mirrors the relevant fields of the trade-webhook `TradeEvent` so alert
 * evaluation can be wired into the same indexer trade-event processing path.
 */
export interface AlertTradeEvent {
  creatorId: string;
  /** The new key price after the trade, as a decimal string. */
  price: string;
  /** ISO-8601 timestamp of the trade. */
  timestamp: string;
}
