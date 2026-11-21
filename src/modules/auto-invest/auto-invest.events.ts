import EventEmitter from 'events';
import { logger } from '../../utils/logger.utils';

/**
 * Payload published after a successful auto-invest execution.
 *
 * Contains only the identifiers needed to correlate the execution with its
 * rule and listing, plus the actor wallet. No wallet secrets or credentials.
 */
export interface AutoInvestExecutedEventPayload {
   event: 'auto_invest_executed';
   ruleId: string;
   listingId: string;
   walletAddress: string;
   transactionHash?: string;
   timestamp: string;
}

export const autoInvestEventEmitter = new EventEmitter();

export function emitAutoInvestExecuted(
   payload: Omit<AutoInvestExecutedEventPayload, 'event' | 'timestamp'>
): void {
   const eventPayload: AutoInvestExecutedEventPayload = {
      event: 'auto_invest_executed',
      timestamp: new Date().toISOString(),
      ...payload,
   };

   logger.info(eventPayload, 'Auto-invest execution event emitted');

   autoInvestEventEmitter.emit('auto_invest_executed', eventPayload);
}
