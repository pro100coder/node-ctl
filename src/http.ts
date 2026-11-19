// The cloud APIs over fetch. Each base URL is an origin an environment variable can replace (the bats
// suite points them at its test server); callers give the full path, version prefix included.
type Env = Record<string, string | undefined>;

const APIS = {
  hetzner: ['NODE_CTL_HETZNER_API', 'https://api.hetzner.cloud'], // /v1/...
  contabo: ['NODE_CTL_CONTABO_API', 'https://api.contabo.com'], // /v1/compute/..., /api-v1.yaml
  contaboAuth: ['NODE_CTL_CONTABO_AUTH', 'https://auth.contabo.com'], // /auth/realms/contabo/protocol/openid-connect/token
  tailscale: ['NODE_CTL_TAILSCALE_API', 'https://api.tailscale.com'], // /api/v2/...
} as const;

type Api = keyof typeof APIS;

export function apiUrl(env: Env, api: Api, path: string): string {
  const [name, fallback] = APIS[api];
  return `${(env[name] || fallback).replace(/\/+$/, '')}${path}`;
}

// A status outside 2xx, as curl -f failed on it. The message names the call, never its headers or body,
// which carry the credentials.
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(method: string, url: string, status: number, body: string) {
    super(`${method} ${url}: HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

// The parsed JSON of the answer, null for an empty one.
export async function request(env: Env, api: Api, path: string, init: RequestInit = {}): Promise<unknown> {
  const url = apiUrl(env, api, path);
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new HttpError(init.method ?? 'GET', url, res.status, text);
  return text ? JSON.parse(text) : null;
}

// Every wait between polls; NODE_CTL_NO_WAIT=1 makes them all zero (the bats suite's sleep stub, in process).
export function sleep(ms: number, env: Env = process.env): Promise<void> {
  return env.NODE_CTL_NO_WAIT === '1' ? Promise.resolve() : Bun.sleep(ms);
}
