/**
 * Helper for converting raw Stellar Soroban event fields into the server's
 * internal trade event schema. The raw event's topic and data are expected
 * to have been pre-processed into decoded strings (not base64-encoded XDR).
 *
 * Throws a typed ParseError when a required field is missing or the wrong type.
 */

export class ParseError extends Error {
  name = 'ParseError';

  constructor(message: string) {
    super(message);
  }
}

export interface RawSorobanEvent {
  /** Ledger sequence number */
  ledger: number;
  /** ISO timestamp of the ledger close */
  ledgerClosedAt: string;
  /** Decoded event topic segments: [event_symbol, creator_id, actor_address] */
  topic: string[];
  /** Decoded event data as a JSON string containing { amount, price, fee } */
  data: string;
}

export interface TradeEvent {
  event_type: 'buy' | 'sell';
  creator_id: string;
  actor_address: string;
  amount: string;
  price: string;
  fee: string;
  ledger_sequence: number;
  timestamp: string;
}

const EVENT_TYPE_MAP: Record<string, 'buy' | 'sell'> = {
  KEY_BOUGHT: 'buy',
  KEY_SOLD: 'sell',
};

function requireString(
  value: unknown,
  fieldName: string,
  context: string
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ParseError(
      `Missing or invalid required field "${fieldName}" in ${context}`
    );
  }
  return value;
}

function requireNumber(
  value: unknown,
  fieldName: string,
  context: string
): number {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new ParseError(
      `Missing or invalid required field "${fieldName}" in ${context}`
    );
  }
  return value;
}

/**
 * Parses a raw Soroban trade event into the server's TradeEvent schema.
 *
 * @param rawEvent - The decoded raw event from the Stellar RPC
 * @returns A structured TradeEvent
 * @throws {ParseError} when any required field is missing or invalid
 */
export function parseStellarTradeEvent(rawEvent: RawSorobanEvent): TradeEvent {
  const { ledger, ledgerClosedAt, topic, data } = rawEvent;

  const rawType = requireString(topic?.[0], 'topic[0] (event_type)', 'topic');
  const event_type = EVENT_TYPE_MAP[rawType];
  if (!event_type) {
    throw new ParseError(
      `Unknown event type "${rawType}" — expected KEY_BOUGHT or KEY_SOLD`
    );
  }

  const creator_id = requireString(topic[1], 'topic[1] (creator_id)', 'topic');
  const actor_address = requireString(
    topic[2],
    'topic[2] (actor_address)',
    'topic'
  );

  const ledger_sequence = requireNumber(ledger, 'ledger', 'root');
  const timestamp = requireString(
    ledgerClosedAt,
    'ledgerClosedAt',
    'root'
  );

  let parsedData: Record<string, unknown>;
  try {
    parsedData = JSON.parse(data);
  } catch {
    throw new ParseError('data must be a valid JSON string');
  }

  if (typeof parsedData !== 'object' || parsedData === null) {
    throw new ParseError('data must be a JSON object');
  }

  const amount = requireString(parsedData.amount, 'amount', 'data');
  const price = requireString(parsedData.price, 'price', 'data');
  const fee = requireString(parsedData.fee, 'fee', 'data');

  return {
    event_type,
    creator_id,
    actor_address,
    amount,
    price,
    fee,
    ledger_sequence,
    timestamp,
  };
}
