   const identifiers = events
      .map(e => `${e.txHash}:${e.eventIndex}`)
      .sort()
      .join('|');
   return createHash('sha256')
      .update(identifiers, 'utf8')
      .digest('hex')
      .slice(0, 16);
}

/**
 * Processes a batch of on-chain KeySunsetFlagged events (#931).
 *
 * Each event stamps `sunsetFlaggedAt` on the matching CreatorProfile and
 * writes a KEY_SUNSET_FLAGGED Activity record so the flag appears in the
 * audit trail.  Already-flagged keys are skipped (idempotent).
 *
 * Expected event fields:
 *   - eventType  : 'KEY_SUNSET_FLAGGED'
 *   - creatorId  : creator profile ID the flag applies to
 *   - flaggedAt  : ISO-8601 timestamp from the contract (optional; falls back to now)
 *   - ledger     : ledger sequence number
 *   - txHash     : transaction hash (for dedup)
 *   - eventIndex : position within the transaction (for dedup)
 */
export async function processSunsetFlaggedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== 'KEY_SUNSET_FLAGGED') {
         return;
      }

      const requiredFields = ['creatorId', 'ledger'];
      for (const field of requiredFields) {
         if (
            event[field] === undefined ||
            event[field] === null ||
            event[field] === ''
         ) {
            logger.warn(
               {
                  eventId: `${event.txHash}:${event.eventIndex}`,
                  missingField: field,
               },
               'Skipping KEY_SUNSET_FLAGGED event due to missing required field'
            );
            return;
         }
      }

      const creatorId = String(event.creatorId);
      const flaggedAt = event.flaggedAt
         ? new Date(String(event.flaggedAt))
         : new Date();

      // Resolve to the canonical profile ID (event may carry handle or id).
      const profile = await prisma.creatorProfile.findFirst({
         where: { OR: [{ id: creatorId }, { handle: creatorId }] },
         select: { id: true, sunsetFlaggedAt: true },
      });

      if (!profile) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               creatorId,
            },
            'KEY_SUNSET_FLAGGED event references unknown creator; skipping'
         );
         return;
      }

      // Idempotent: if the flag is already set, skip further writes.
      if (profile.sunsetFlaggedAt !== null) {
         logger.info(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               creatorId: profile.id,
               sunsetFlaggedAt: profile.sunsetFlaggedAt.toISOString(),
            },
            'KEY_SUNSET_FLAGGED already recorded; skipping duplicate event'
         );
         return;
      }

      await prisma.$transaction([
         // Stamp the flag on the creator profile.
         prisma.creatorProfile.update({
            where: { id: profile.id },
            data: { sunsetFlaggedAt: flaggedAt },
         }),
         // Write an Activity record for the audit trail.
         prisma.activity.create({
            data: {
               type: 'KEY_SUNSET_FLAGGED' as any,
               actor: creatorId,
               creatorId: profile.id,
               payload: {
                  ledger_sequence: Number(event.ledger),
                  flagged_at: flaggedAt.toISOString(),
               },
               createdAt: flaggedAt,
            },
         }),
      ]);

      logger.info(
         {
            creatorId: profile.id,
            sunsetFlaggedAt: flaggedAt.toISOString(),
            ledger: event.ledger,
            txHash: event.txHash,
         },
         'KEY_SUNSET_FLAGGED event processed; creator profile stamped'
      );
   });
}
