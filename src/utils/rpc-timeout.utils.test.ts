import { strict as assert } from 'assert';
import { withRpcTimeout, RpcTimeoutError, DEFAULT_RPC_TIMEOUT_MS } from './rpc-timeout.utils';

async function run() {
   // resolves before timeout
   const result = await withRpcTimeout('ok', () => Promise.resolve(42), 100);
   assert.equal(result, 42, 'should resolve with the wrapped value');

   // rejects with RpcTimeoutError when the promise is too slow
   await assert.rejects(
      () =>
         withRpcTimeout(
            'slow',
            () => new Promise((resolve) => setTimeout(resolve, 200)),
            50
         ),
      (err: unknown) => {
         assert.ok(err instanceof RpcTimeoutError, 'should be RpcTimeoutError');
         assert.equal((err as RpcTimeoutError).operation, 'slow');
         assert.equal((err as RpcTimeoutError).timeoutMs, 50);
         assert.ok((err as RpcTimeoutError).message.includes('50ms'));
         assert.ok((err as RpcTimeoutError).isTimeout);
         return true;
      }
   );

   // propagates non-timeout rejections unchanged
   await assert.rejects(
      () => withRpcTimeout('fail', () => Promise.reject(new Error('boom')), 100),
      (err: unknown) => {
         assert.ok(err instanceof Error);
         assert.equal((err as Error).message, 'boom');
         return true;
      }
   );

   // default timeout constant is exported and numeric
   assert.equal(typeof DEFAULT_RPC_TIMEOUT_MS, 'number');

   console.log('rpc-timeout.utils tests passed');
}

run().catch((err) => {
   console.error(err);
   process.exit(1);
});
