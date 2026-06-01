import { strict as assert } from 'assert';
import { dedupeChainEvents, ChainEvent } from './indexer-dedupe.utils';

function run() {
  console.log('Running indexer-dedupe.utils tests...');

  // Case 1: Unique events are all kept
  {
    const events: ChainEvent[] = [
      { txHash: '0x1', eventIndex: 0 },
      { txHash: '0x1', eventIndex: 1 },
      { txHash: '0x2', eventIndex: 0 },
    ];
    const deduped = dedupeChainEvents(events);
    assert.equal(deduped.length, 3, 'Should keep all unique events');
  }

  // Case 2: Duplicate events are removed
  {
    const events: ChainEvent[] = [
      { txHash: '0x1', eventIndex: 0 },
      { txHash: '0x1', eventIndex: 0 }, // Duplicate
      { txHash: '0x2', eventIndex: 0 },
    ];
    const deduped = dedupeChainEvents(events);
    assert.equal(deduped.length, 2, 'Should remove duplicate events');
    assert.equal(deduped[0].txHash, '0x1');
    assert.equal(deduped[1].txHash, '0x2');
  }

  // Case 3: Empty list
  {
    const deduped = dedupeChainEvents([]);
    assert.equal(deduped.length, 0, 'Should handle empty list');
  }

  // Case 4: Events with extra data are preserved
  {
    const events = [
      { txHash: '0x1', eventIndex: 0, data: 'foo' },
      { txHash: '0x1', eventIndex: 0, data: 'bar' }, // Duplicate txHash/index but different data
    ];
    const deduped = dedupeChainEvents(events);
    assert.equal(deduped.length, 1, 'Should dedupe regardless of extra data');
    assert.equal(deduped[0].data, 'foo', 'Should keep the first occurrence');
  }

  console.log('indexer-dedupe.utils tests passed');
}

run();
