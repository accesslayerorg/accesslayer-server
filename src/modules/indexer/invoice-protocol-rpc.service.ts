import { prisma } from '../../utils/prisma.utils';
import { processIndexerEvents } from './indexer-pipeline.service';
import {
   decodeInvoiceProtocolRpcEvent,
   InvoiceProtocolRpcEvent,
} from './invoice-protocol.events';

/**
 * External worker adapter for a getEvents page filtered to invoice protocol
 * contracts. Persist the opaque RPC cursor only after every event succeeds.
 * Workers must serialize pages and pass the RPC page cursor (including empty
 * pages), never synthesize a ledger cursor or skip the remainder of a ledger.
 */
export async function processInvoiceProtocolRpcPage(page: {
   events: InvoiceProtocolRpcEvent[];
   cursor: string;
   latestLedger: number;
}): Promise<void> {
   if (
      !page.cursor ||
      !Number.isSafeInteger(page.latestLedger) ||
      page.latestLedger < 0
   ) {
      throw new Error('Invalid RPC page checkpoint');
   }
   const events = page.events
      .map(decodeInvoiceProtocolRpcEvent)
      .filter(event => event !== null);
   await processIndexerEvents(events, { advanceCursor: false });
   // Do not mark latestLedger as processed when this page ends inside a ledger.
   const lastLedger = page.events.length
      ? page.events[page.events.length - 1].ledger
      : page.latestLedger;
   // This stream is filtered by contract; it cannot advance the shared trade
   // checkpoint or unrelated event types could be lost by another worker.
   await prisma.invoiceProtocolCursor.upsert({
      where: { id: 1 },
      create: { id: 1, ledger: lastLedger, cursor: page.cursor },
      update: { ledger: lastLedger, cursor: page.cursor },
   });
}
