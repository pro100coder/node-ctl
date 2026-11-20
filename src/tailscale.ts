// The Tailscale API: the OAuth client's token, the removal of a machine's node, and the creation of
// the OAuth client itself from an API access token (init).
import { request } from './http.ts';

type Env = Record<string, string | undefined>;
type Client = { client_id: string; client_secret: string };

const json = (v: unknown) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
// jq -r .x printed null as the word null; an answer without the field is a failure further on, not here
const field = (v: unknown, key: string) => String(json(v)[key] ?? 'null');

type Call = { timeout?: number; retries?: number };

export async function token(env: Env, client: Client, call: Call = {}): Promise<string> {
  const body = new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret });
  return field(await request(env, 'tailscale', '/api/v2/oauth/token', { method: 'POST', body }, call), 'access_token');
}

// tailscale-rm.sh: for a machine that can no longer run tailscale logout itself. Only tag:dev nodes, and
// matched on the tailnet's name for the node (dev1 of dev1.tail.ts.net), never the raw OS hostname: a
// stale node and a rebuilt one can share that, and the live one must not go. A stalled connection
// would otherwise hang until the kernel gives up (~2 min), so every call is bounded and retried,
// the DELETE included (a repeated one is a 404, and a rerun copes).
export async function removeNode(env: Env, client: Client, name: string, timeout = 30_000): Promise<void> {
  const call = { timeout, retries: 3 };
  const auth = { Authorization: `Bearer ${await token(env, client, call)}` };
  const listed = json(await request(env, 'tailscale', '/api/v2/tailnet/-/devices', { headers: auth }, call));
  const devices = Array.isArray(listed.devices) ? listed.devices.map(json) : [];
  for (const d of devices) {
    const tags = Array.isArray(d.tags) ? d.tags : [];
    if (String(d.name).split('.')[0] !== name || !tags.includes('tag:dev')) continue;
    await request(env, 'tailscale', `/api/v2/device/${String(d.id)}`, { method: 'DELETE', headers: auth }, call);
  }
}

// tailscale-oauth-client.sh: allows tag:dev in the policy and creates a client with the scopes the
// Terraform module needs. The policy is posted back as plain JSON, so comments of a HuJSON policy are lost.
export async function createClient(env: Env, apiKey: string): Promise<Client> {
  const headers = {
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const acl = json(await request(env, 'tailscale', '/api/v2/tailnet/-/acl', { headers }));
  acl.tagOwners = { ...json(acl.tagOwners), 'tag:dev': ['autogroup:admin'] };
  await request(env, 'tailscale', '/api/v2/tailnet/-/acl', { method: 'POST', headers, body: JSON.stringify(acl) });
  const key = await request(env, 'tailscale', '/api/v2/tailnet/-/keys', {
    method: 'POST',
    headers,
    body: JSON.stringify({ keyType: 'client', scopes: ['auth_keys', 'devices:core'], tags: ['tag:dev'], description: 'node-ctl' }),
  });
  return { client_id: field(key, 'id'), client_secret: field(key, 'key') };
}
