import { afterAll, expect, test } from 'bun:test';
import { removeNode } from '../src/tailscale.ts';

// tailscale-rm.sh ran every call with curl --max-time 30 --retry 3 --retry-all-errors: a stalled or
// failing API is tried four times in all, each attempt bounded, before the removal gives up.
let failures = 0;
let hang = false;
const seen: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    seen.push(`${req.method} ${url.pathname}`);
    if (hang) await Bun.sleep(2000);
    if (failures > 0) {
      failures--;
      return new Response('busy', { status: 503 });
    }
    if (url.pathname === '/api/v2/oauth/token') return Response.json({ access_token: 'at' });
    if (url.pathname === '/api/v2/tailnet/-/devices') {
      return Response.json({
        devices: [
          { id: 'n1', name: 'dev1.tail.ts.net', tags: ['tag:dev'] },
          { id: 'n2', name: 'dev1-1.tail.ts.net', tags: ['tag:dev'] }, // a rebuilt machine's live node
          { id: 'n3', name: 'dev1.tail.ts.net', tags: [] }, // not ours
        ],
      });
    }
    return new Response('');
  },
});
afterAll(() => server.stop(true));
const env = { NODE_CTL_TAILSCALE_API: `http://127.0.0.1:${server.port}`, NODE_CTL_NO_WAIT: '1' };
const client = { client_id: 'k', client_secret: 's' };

test('removeNode deletes only the tag:dev node the tailnet names after the machine', async () => {
  seen.length = 0;
  await removeNode(env, client, 'dev1');
  expect(seen).toEqual(['POST /api/v2/oauth/token', 'GET /api/v2/tailnet/-/devices', 'DELETE /api/v2/device/n1']);
});

test('every call is retried three times, so three failures in a row still remove the node', async () => {
  seen.length = 0;
  failures = 3;
  await removeNode(env, client, 'dev1');
  expect(seen.filter((s) => s === 'POST /api/v2/oauth/token')).toHaveLength(4);
  expect(seen).toContain('DELETE /api/v2/device/n1');
});

test('a fourth failure gives up with the HTTP error', async () => {
  seen.length = 0;
  failures = 4;
  await expect(removeNode(env, client, 'dev1')).rejects.toThrow('HTTP 503');
  expect(seen).toHaveLength(4);
  failures = 0;
});

test('an answer that never comes is cut off by the timeout on each attempt, four of them', async () => {
  seen.length = 0;
  hang = true;
  const t0 = performance.now();
  await expect(removeNode(env, client, 'dev1', 50)).rejects.toThrow();
  hang = false;
  expect(seen).toHaveLength(4);
  expect(performance.now() - t0).toBeLessThan(1500); // bounded: not the 2 s the server would take even once
});
