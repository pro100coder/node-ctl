import { afterAll, expect, test } from 'bun:test';
import { apiUrl, HttpError, request, sleep } from '../src/http.ts';

const seen: { method: string; path: string; auth: string | null }[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    seen.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.get('authorization') });
    if (url.pathname === '/v1/servers') return Response.json({ servers: [{ id: 1 }] });
    if (url.pathname === '/empty') return new Response('');
    return new Response('{"error":"nope"}', { status: 404 });
  },
});
afterAll(() => server.stop(true));
const env = { NODE_CTL_HETZNER_API: `http://127.0.0.1:${server.port}` };

test('each API has its production origin, and its variable replaces it', () => {
  expect(apiUrl({}, 'hetzner', '/v1/servers')).toBe('https://api.hetzner.cloud/v1/servers');
  expect(apiUrl({}, 'contabo', '/v1/compute/instances')).toBe('https://api.contabo.com/v1/compute/instances');
  expect(apiUrl({}, 'contaboAuth', '/auth/realms/contabo/protocol/openid-connect/token')).toBe(
    'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token',
  );
  expect(apiUrl({}, 'tailscale', '/api/v2/tailnet/-/devices')).toBe('https://api.tailscale.com/api/v2/tailnet/-/devices');
  expect(apiUrl({ NODE_CTL_CONTABO_API: 'http://localhost:9/' }, 'contabo', '/v1/x')).toBe('http://localhost:9/v1/x');
  expect(apiUrl({ NODE_CTL_CONTABO_AUTH: 'http://a' }, 'contaboAuth', '/t')).toBe('http://a/t');
  expect(apiUrl({ NODE_CTL_TAILSCALE_API: 'http://t' }, 'tailscale', '/api/v2')).toBe('http://t/api/v2');
});

test('a request answers the parsed JSON, null for an empty body; the token goes in a header', async () => {
  expect(await request(env, 'hetzner', '/v1/servers?name=dev1', { headers: { Authorization: 'Bearer t1' } })).toEqual({ servers: [{ id: 1 }] });
  expect(seen.at(-1)).toEqual({ method: 'GET', path: '/v1/servers?name=dev1', auth: 'Bearer t1' });
  expect(await request(env, 'hetzner', '/empty')).toBeNull();
});

test('a status outside 2xx fails, as curl -f did, naming the call and its status but no credential', async () => {
  const call = request(env, 'hetzner', '/v1/images/9', { method: 'DELETE', headers: { Authorization: 'Bearer secret-token' } });
  await expect(call).rejects.toThrow(new HttpError('DELETE', `${env.NODE_CTL_HETZNER_API}/v1/images/9`, 404, ''));
  const e = await call.catch((x: unknown) => x);
  expect(e).toMatchObject({ status: 404, body: '{"error":"nope"}' });
  expect(String(e)).not.toContain('secret-token');
});

test('NODE_CTL_NO_WAIT=1 makes every wait zero; without it a wait waits', async () => {
  let t = performance.now();
  await sleep(5_000, { NODE_CTL_NO_WAIT: '1' });
  expect(performance.now() - t).toBeLessThan(100);
  t = performance.now();
  await sleep(50, {});
  expect(performance.now() - t).toBeGreaterThanOrEqual(45);
});
