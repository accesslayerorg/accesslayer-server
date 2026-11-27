import http from 'node:http';
let ledger = 1000;
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const msg = body ? JSON.parse(body) : {};
  const method = msg.method;
  const id = msg.id ?? 1;
  let result = {};
  if (method === 'getHealth') result = { status: 'healthy' };
  else if (method === 'getLatestLedger') result = { sequence: ledger++ };
  else if (method === 'getEvents') result = { events: [], latestLedger: ledger };
  else if (method === 'sendTransaction') result = { status: 'PENDING', hash: 'deadbeef' };
  else if (method === 'getTransaction') result = { status: 'SUCCESS', ledger };
  else result = { ok: true };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
});
server.listen(8080, () => console.log('mock soroban rpc on 8080'));
