import {
   CreatorSequencer,
   SequencerTimeoutError,
} from './creator-sequencer.utils';

jest.mock('./logger.utils', () => ({
   logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

describe('CreatorSequencer (#758)', () => {
   let sequencer: CreatorSequencer;

   beforeEach(() => {
      sequencer = new CreatorSequencer();
   });

   afterEach(() => {
      sequencer.dispose();
      jest.restoreAllMocks();
   });

   it('serialises operations for the same creator in FIFO order', async () => {
      const executionOrder: number[] = [];

      const op1 = () =>
         new Promise<void>(resolve => {
            setTimeout(() => {
               executionOrder.push(1);
               resolve();
            }, 50);
         });

      const op2 = () =>
         new Promise<void>(resolve => {
            executionOrder.push(2);
            resolve();
         });

      const op3 = () =>
         new Promise<void>(resolve => {
            executionOrder.push(3);
            resolve();
         });

      const p1 = sequencer.enqueue('creator-wallet-1', op1);
      const p2 = sequencer.enqueue('creator-wallet-1', op2);
      const p3 = sequencer.enqueue('creator-wallet-1', op3);

      await Promise.all([p1, p2, p3]);

      expect(executionOrder).toEqual([1, 2, 3]);
   });

   it('allows concurrent operations for different creators', async () => {
      const active: string[] = [];

      const opA = () =>
         new Promise<void>(resolve => {
            active.push('A-start');
            setTimeout(() => {
               active.push('A-end');
               resolve();
            }, 50);
         });

      const opB = () =>
         new Promise<void>(resolve => {
            active.push('B-start');
            setTimeout(() => {
               active.push('B-end');
               resolve();
            }, 10);
         });

      const pA = sequencer.enqueue('creator-A', opA);
      const pB = sequencer.enqueue('creator-B', opB);

      await Promise.all([pA, pB]);

      expect(active).toContain('A-start');
      expect(active).toContain('B-start');
   });

   it('rejects queued operations with SequencerTimeoutError if waiting > 10s', async () => {
      let resolveSlowOp: () => void = () => {};
      const slowOp = () =>
         new Promise<void>(resolve => {
            resolveSlowOp = resolve;
         });

      const queuedOp = () => Promise.resolve('ok');

      const p1 = sequencer.enqueue('creator-slow', slowOp);
      const p2 = sequencer.enqueue('creator-slow', queuedOp);

      const realNow = Date.now;
      jest.spyOn(Date, 'now').mockReturnValue(realNow() + 11_000);

      resolveSlowOp();

      await expect(p2).rejects.toThrow(SequencerTimeoutError);
      await p1;
   });

   it('cleans up inactive queues after 5 minutes', async () => {
      jest.useFakeTimers();

      const op = () => Promise.resolve('done');
      await sequencer.enqueue('creator-idle', op);

      expect(sequencer.activeQueues).toBe(1);

      jest.advanceTimersByTime(5 * 60 * 1000 + 100);

      expect(sequencer.activeQueues).toBe(0);

      jest.useRealTimers();
   });
});
