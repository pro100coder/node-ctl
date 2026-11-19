// The Contabo API for what its Terraform provider does not model (ADR-0018). Credentials are the
// account's own, handed to each call; every request carries its own x-request-id, which is also what
// Contabo support asks for.
import { request, sleep } from './http.ts';

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

type Instance = { displayName?: unknown; status?: unknown; addOns?: unknown };

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
