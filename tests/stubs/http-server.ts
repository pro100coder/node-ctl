// Test stand-in for every HTTP API the compiled node-ctl calls. tests/stubs/node-ctl-bin starts one per
// invocation. It listens on one port per service and prints "<service> <port>" lines on stdout (hetzner,
// tailscale, contabo, contabo-auth). The binary reads each service's ORIGIN (scheme://host:port, no path; it appends /v1/..., /api/v2/..., /api-v1.yaml, the
// OAuth token path) from:
//   NODE_CTL_HETZNER_API    default https://api.hetzner.cloud
//   NODE_CTL_TAILSCALE_API  default https://api.tailscale.com
//   NODE_CTL_CONTABO_API    default https://api.contabo.com
//   NODE_CTL_CONTABO_AUTH   default https://auth.contabo.com
// The wrapper sets them to http://127.0.0.1:<port>.
// Every request is appended to $STUB_LOG as one line, under the real service's URL so assertions do not care
// where the server listens:
//   http: <METHOD> <canonical url with query> [auth=<Authorization value, Basic as user only>] [body=<compact json | decoded form>]
// Tokens in the suite are fixtures, so they stay readable: that is how a test tells t from t2.
// Behaviour (named after the curl stub of the bash CLI): STUB_CURL_BODY answers everything, STUB_FAIL=curl
// rejects everything with 401, curl-devices rejects */devices with 403, STUB_CURL_FAIL_ONCE=<suffix> drops
// the first request whose URL ends in it, STUB_CONTABO_STATUS / STUB_CONTABO_ADDONS shape the instance list.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const env = process.env;
const log = env.STUB_LOG;
if (!log) throw new Error('STUB_LOG is not set');

const REAL: Record<string, string> = {
  hetzner: 'https://api.hetzner.cloud',
  tailscale: 'https://api.tailscale.com',
  contabo: 'https://api.contabo.com',
  'contabo-auth': 'https://auth.contabo.com',
};
const DEFAULT = '{"id":"kid","key":"tskey-client-k","access_token":"at","devices":[],"servers":[{"id":7}],"server":{"status":"off"},"image":{"id":"4711","status":"available"},"images":[{"id":4711,"description":"node-ctl dev1"}],"data":[{"imageId":"img-ubuntu-24.04","name":"ubuntu-24.04"}]}';
const SPEC = `paths:
  /v1/compute/instances:
    post:
      description: >-
        Create a new instance. <table> <tr><th>ProductId</th><th>Product</th><th>Disk Size</th></tr>
        <tr><td>V153</td><td>Cloud VPS 4</td><td>100 GB SSD</td></tr> <tr><td>V159</td><td>Cloud VPS Plus 4</td><td>150 GB NVMe</td></tr>
        <tr><td>V93</td><td>VPS 10 Storage</td><td>300 GB SSD</td></tr> <tr><td>V16</td><td>VDS XXL</td><td>720 GB NVMe</td></tr> </table>
`;

function compact(body: string, type: string): string {
  if (type.includes('x-www-form-urlencoded')) return [...new URLSearchParams(body)].map(([k, v]) => `${k}=${v}`).join('&');
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    return body;
  }
}

function auth(h: string | undefined): string {
  if (!h) return '';
  if (h.startsWith('Basic ')) return ` auth=Basic ${Buffer.from(h.slice(6), 'base64').toString().replace(/:$/, '')}`;
  return ` auth=${h}`;
}

const serve = (base: string) => createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(base + (req.url ?? '/'));
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? ` body=${compact(raw, req.headers['content-type'] ?? '')}` : '';
    appendFileSync(log, `http: ${req.method} ${url.href}${auth(req.headers.authorization)}${body}\n`);

    const fail = (code: number): void => void res.writeHead(code, { 'content-type': 'application/json' }).end('{"error":"stub"}');
    const failing = ` ${env.STUB_FAIL ?? ''} `;
    if (failing.includes(' curl ')) return fail(401);
    if (failing.includes(' curl-devices ') && url.pathname.endsWith('/devices')) return fail(403);
    const once = env.STUB_CURL_FAIL_ONCE;
    if (once && (url.pathname + url.search).endsWith(once) && !existsSync(`${log}.failed-once`)) {
      writeFileSync(`${log}.failed-once`, '');
      req.socket.destroy(); // a dropped connection, not an HTTP error
      return;
    }

    let out = env.STUB_CURL_BODY;
    if (!out) {
      const name = url.searchParams.get('displayName');
      if (name !== null) {
        const addons = env.STUB_CONTABO_ADDONS ?? '[{"id":1501,"quantity":1}]';
        out = `{"data":[{"instanceId":99,"displayName":"${name}","status":"${env.STUB_CONTABO_STATUS ?? 'running'}","addOns":${addons}}]}`;
      } else if (url.pathname.endsWith('/api-v1.yaml')) out = SPEC;
      else out = DEFAULT;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(out);
  });
});

for (const [name, base] of Object.entries(REAL)) {
  serve(base).listen(0, '127.0.0.1', function (this: ReturnType<typeof createServer>) {
    const addr = this.address();
    if (addr && typeof addr === 'object') process.stdout.write(`${name} ${addr.port}\n`);
  });
}
