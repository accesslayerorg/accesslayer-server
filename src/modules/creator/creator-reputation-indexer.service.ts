import { recordReputationEvent } from './creator-reputation.service';
import { logger } from '../../utils/logger.utils';

/**
 * Interface for events that affect creator reputation
 */
export interface ReputationEvent {
   eventType: 'KEY_LAUNCHED' | 'MILESTONE_REACHED' | 'GOVERNANCE_VOTE' | 'KEY_DEPRECATED';
   creatorId: string;
   ledger: number;
   txHash?: string;
}

/**
 * Process reputation-affecting events from the indexer.
 * Records events in the reputation history and updates scores.
 */
export async function processReputationEvents(
   events: ReputationEvent[]
): Promise<void> {
   if (events.length === 0) {
      return;
   }

   for (const event of events) {
      try {
         await recordReputationEvent(
            event.creatorId,
            event.eventType,
            event.ledger,
            event.txHash
         );

         logger.info(
            {
               eventType: event.eventType,
               creatorId: event.creatorId,
               ledger: event.ledger,
               txHash: event.txHash,
            },
            'Reputation event processed'
         );
      } catch (error) {
         logger.error(
            {
               error,
               event,
            },
            'Failed to process reputation event'
         );
         // Don't throw - continue processing other events
      }
   }
}

/**
 * Detect and process key launch events.
 * A new key launch is detected when CREATOR_REGISTERED activity occurs.
 */
export async function processKeyLaunchEvent(
   creatorId: string,
   ledger: number,
   txHash: string
): Promise<void> {
   await recordReputationEvent(
      creatorId,
      'KEY_LAUNCHED',
      ledger,
      txHash
   );
}

/**
 * Detect and process milestone reached events.
 * Milestones are triggered when supply reaches configured thresholds (10, 100, 1000, 10000).
 */
export async function processMilestoneReachedEvent(
   creatorId: string,
   ledger: number,
   txHash: string
): Promise<void> {
   await recordReputationEvent(
      creatorId,
      'MILESTONE_REACHED',
      ledger,
      txHash
   );
}

/**
 * Detect and process governance vote events.
 * Called when a GOVERNANCE_PROPOSAL_CREATED activity or GovernanceVote is recorded.
 */
export async function processGovernanceVoteEvent(
   creatorId: string,
   ledger: number,
   txHash: string
): Promise<void> {
   await recordReputationEvent(
      creatorId,
      'GOVERNANCE_VOTE',
      ledger,
      txHash
   );
}

/**
 * Detect and process key deprecation events.
 * Called when a key is deprecated (deprecatedAt is set).
 */
export async function processKeyDeprecationEvent(
   creatorId: string,
   ledger: number,
   txHash: string
): Promise<void> {
   await recordReputationEvent(
      creatorId,
      'KEY_DEPRECATED',
      ledger,
      txHash
   );
}
