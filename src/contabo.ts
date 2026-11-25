// The Contabo API for what its Terraform provider does not model (ADR-0018). Credentials are the
// account's own, handed to each call; every request carries its own x-request-id, which is also what
// Contabo support asks for.
import { apiUrl, request, sleep } from './http.ts';

type Env = Record<string, string | undefined>;
type Account = { client_id: string; client_secret: string; user: string; password: string };

const TOKEN = '/auth/realms/contabo/protocol/openid-connect/token';

// The same OAuth2 password grant the Terraform provider makes; '' when the answer has no token.
export async function token(env: Env, a: Account): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: a.client_id,
    client_secret: a.client_secret,
    username: a.user,
    password: a.password,
  });
  const answer = (await request(env, 'contaboAuth', TOKEN, { method: 'POST', body })) as { access_token?: unknown } | null;
  return typeof answer?.access_token === 'string' ? answer.access_token : '';
}

export function compute(env: Env, bearer: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = { Authorization: `Bearer ${bearer}`, 'x-request-id': crypto.randomUUID(), 'Content-Type': 'application/json' };
  return request(env, 'contabo', path, { ...init, headers });
}

type Instance = { instanceId?: unknown; displayName?: unknown; status?: unknown; addOns?: unknown };

// contabo.sh power: an instance is a monthly contract, so stop powers it off instead of deleting it,
// and start powers it on; restart restarts it. The display name is what Terraform sets to the machine's name.
export async function power(env: Env, a: Account, name: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
  const t = await token(env, a);
  if (!t) throw new Error('Contabo refused the credentials: no access token');
  const answer = (await compute(env, t, `/v1/compute/instances?size=100&displayName=${encodeURIComponent(name)}`)) as { data?: Instance[] } | null;
  const id = answer?.data?.find((d) => d.displayName === name)?.instanceId;
  if (id == null) throw new Error(`no Contabo instance named ${name}`);
  await compute(env, t, `/v1/compute/instances/${String(id)}/actions/${action}`, { method: 'POST' });
}

// contabo.sh wait: until the instance has finished provisioning, 15 minutes at most. Until then a
// firewall is refused with 402: its add-on (free, but part of the contract) arrives after the status
// already says running, so the add-on list is waited for too.
// shortcut: any add-on counts, node-ctl orders none itself; match the firewall's id if one ever is.
export async function waitInstance(env: Env, a: Account, name: string): Promise<void> {
  let status = '';
  for (let i = 0; i < 90; i++) {
    const t = await token(env, a); // a token lives minutes, and the wait can take longer
    if (!t) throw new Error('Contabo refused the credentials: no access token');
    const answer = (await compute(env, t, `/v1/compute/instances?size=100&displayName=${encodeURIComponent(name)}`)) as { data?: Instance[] } | null;
    const it = answer?.data?.find((d) => d.displayName === name);
    const addOns = Array.isArray(it?.addOns) ? it.addOns : [];
    status = it ? String(it.status) : '';
    if (it && !addOns.length && (status === 'running' || status === 'stopped')) status = 'waiting for its firewall add-on';
    if (status === 'running' || status === 'stopped') return;
    await sleep(10_000, env);
  }
  throw new Error(`the Contabo instance ${name} is still ${status || 'not found'} after 15 minutes`);
}

// contabo.sh image: the id (a UUID) of a standard image. A changed id reinstalls the machine, so create
// looks it up once and the inventory carries it from then on.
export async function image(env: Env, a: Account, name = 'ubuntu-24.04'): Promise<string> {
  const t = await token(env, a);
  if (!t) throw new Error('Contabo refused the credentials: no access token');
  const answer = (await compute(env, t, `/v1/compute/images?standardImage=true&size=100&name=${encodeURIComponent(name)}`)) as {
    data?: { name?: unknown; imageId?: unknown }[];
  } | null;
  const id = answer?.data?.find((d) => d.name === name)?.imageId;
  if (typeof id !== 'string' || !id) throw new Error(`Contabo has no standard image named ${name}`);
  return id;
}

// The regions the Terraform provider documents (contabo/resource_instance.go).
export const REGIONS = ['EU', 'US-central', 'US-east', 'US-west', 'SIN'];

// "<id> <product>, <disk>" per product. Contabo has no catalogue endpoint and no prices in its API: the
// products are documented only by the table in createInstance's description, inside the public OpenAPI
// spec, read on every create so a new line-up needs no release. A shortcut, not a whitelist: an id typed
// in full is taken as it is. [] when the spec cannot be read.
export async function products(env: Env): Promise<string[]> {
  let spec: unknown;
  try {
    const res = await fetch(apiUrl(env, 'contabo', '/api-v1.yaml'));
    if (!res.ok) return [];
    spec = Bun.YAML.parse(await res.text());
  } catch {
    return [];
  }
  const paths = (spec as { paths?: Record<string, { post?: { description?: unknown } }> } | null)?.paths;
  const description = paths?.['/v1/compute/instances']?.post?.description;
  if (typeof description !== 'string') return [];
  return [...description.matchAll(/<tr><td>([^<\n]*)<\/td><td>([^<\n]*)<\/td><td>([^<\n]*)<\/td><\/tr>/g)].map((m) => `${m[1]} ${m[2]}, ${m[3]}`);
}
