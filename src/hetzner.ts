// The Hetzner Cloud API for what Terraform does not answer: the server types on offer, a machine's
// disk, its disk snapshot, and powering a server on (scripts/server-types.sh, image.sh, poweron.sh).
// The token is the machine's account's, handed to each call.
import { request, sleep } from './http.ts';

type Env = Record<string, string | undefined>;

const get = (env: Env, token: string, path: string, init: RequestInit = {}) =>
  request(env, 'hetzner', path, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } }) as Promise<Record<
    string,
    unknown
  > | null>;

// One menu row: the type, what it has, what it costs a month, and the last column: the locations that
// create one now (create), or yes|no, whether Hetzner puts this machine there now (move).
export interface TypeRow {
  name: string;
  cores: number;
  memory: number;
  cpu: string;
  disk: number;
  price: number;
  last: string;
}

interface ServerType {
  name: string;
  cores: number;
  memory: number;
  cpu_type: string;
  disk: number;
  architecture?: string;
  deprecation?: unknown;
  locations?: { name: string; available?: boolean }[];
  prices?: { location: string; price_monthly: { gross: string } }[];
}

const cents = (n: number) => Math.round(n * 100) / 100;
const row = (s: ServerType, price: number, last: string): TypeRow => ({
  name: s.name,
  cores: s.cores,
  memory: s.memory,
  cpu: s.cpu_type,
  disk: s.disk,
  price,
  last,
});

// server_types[].locations[].available is the one answer Hetzner gives for both a resize and a create.
// A price predicts neither (the whole CX line is priced where it is sold nowhere), and /datacenters is
// gone (410 since 2026-10-01). It is an indicator and a menu, not a gate: --type and --location go
// straight to Terraform.
export function createRows(types: ServerType[]): TypeRow[] {
  return types.flatMap((s) => {
    if (s.deprecation != null) return [];
    const where = (s.locations ?? []).filter((l) => l.available).map((l) => l.name);
    const p = (s.prices ?? []).filter((x) => where.includes(x.location));
    if (!p.length) return [];
    const price = cents(Math.min(...p.map((x) => Number(x.price_monthly.gross))));
    return [row(s, price, p.map((x) => x.location).sort().join(','))];
  });
}

// Every type of the machine's architecture priced in its location (an x86 machine cannot migrate to
// ARM); yes when Hetzner takes it there now and it holds the disk (GB; the type's own by default:
// a disk never shrinks).
export function moveRows(types: ServerType[], location: string, current: string, disk?: number): TypeRow[] {
  const now = types.find((s) => s.name === current);
  if (!now) throw new Error(`unknown server type: ${current}`);
  const have = disk ?? now.disk;
  return types.flatMap((s) => {
    if (s.architecture !== now.architecture) return [];
    const can = (s.locations ?? []).some((l) => l.available && l.name === location) && s.disk >= have;
    return (s.prices ?? []).filter((x) => x.location === location).map((x) => row(s, cents(Number(x.price_monthly.gross)), can ? 'yes' : 'no'));
  });
}

// Cheapest first; the sort is stable, so equal prices keep Hetzner's order.
export async function serverTypes(env: Env, token: string, rows: (types: ServerType[]) => TypeRow[]): Promise<TypeRow[]> {
  const answer = await get(env, token, '/v1/server_types?per_page=100');
  const types = answer?.server_types;
  if (!Array.isArray(types)) throw new Error('Hetzner answered no server types');
  return rows(types as ServerType[]).sort((a, b) => a.price - b.price);
}

const first = (v: unknown, key: string) => (Array.isArray(v) ? (v[0] as Record<string, unknown> | undefined)?.[key] : undefined);

// The machine's root disk in GB: its server's, or its snapshot's while stopped; undefined when nothing
// of it exists there.
export async function diskOf(env: Env, token: string, name: string, image?: string): Promise<number | undefined> {
  try {
    const size = first((await get(env, token, `/v1/servers?name=${encodeURIComponent(name)}`))?.servers, 'primary_disk_size');
    if (typeof size === 'number') return size;
  } catch {}
  if (!image) return undefined;
  try {
    const size = ((await get(env, token, `/v1/images/${encodeURIComponent(image)}`))?.image as { disk_size?: unknown } | undefined)?.disk_size;
    return typeof size === 'number' ? size : undefined;
  } catch {
    return undefined;
  }
}

// Terraform stops a machine before it changes its type and leaves it stopped when Hetzner refuses the
// new one; nothing in the configuration tracks power state, so no apply would start it again.
export async function powerOn(env: Env, token: string, name: string): Promise<void> {
  const id = first((await get(env, token, `/v1/servers?name=${encodeURIComponent(name)}`))?.servers, 'id');
  if (id == null) throw new Error(`no server named ${name}`);
  await get(env, token, `/v1/servers/${String(id)}/actions/poweron`, { method: 'POST' });
}

// The root disk of a machine, kept as a Hetzner snapshot: it holds /data too, so it is the only copy of a
// stopped machine and a rollback point of a running one (ADR-0016). Matched by description, the only mark
// a snapshot gets, so none needs migrating or labelling.
type Image = { id?: unknown; description?: unknown; status?: unknown };

// shortcut: one page of snapshots; a project with 100+ of them needs pagination here.
async function snapshots(env: Env, token: string, name: string): Promise<Image[]> {
  const images = (await get(env, token, '/v1/images?type=snapshot&per_page=100'))?.images;
  return (Array.isArray(images) ? (images as Image[]) : []).filter((i) => i.description === `node-ctl ${name}`);
}

const status = async (env: Env, token: string, path: string, key: string) => {
  try {
    return String(((await get(env, token, path))?.[key] as { status?: unknown } | undefined)?.status ?? '');
  } catch {
    return ''; // a dropped request is one more wait, not a failed stop
  }
};

// image.sh create: the server powered off, its disk snapshotted; the image id once Hetzner says it is
// available, and only then: the VPS deleted while its snapshot is still being written takes the
// snapshot with it. say() narrates on the action's stderr.
export async function createImage(env: Env, token: string, name: string, say: (line: string) => void): Promise<string> {
  // A snapshot only ever starts being written here, and only with the server already off: one left in
  // creating is a previous stop that ran out of patience, so it is waited for instead of paying twice.
  let image = (await snapshots(env, token, name)).find((i) => i.status === 'creating')?.id;
  if (image != null) say(`snapshot ${String(image)} of ${name} is still being written; waiting for it`);
  else {
    const id = first((await get(env, token, `/v1/servers?name=${encodeURIComponent(name)}`))?.servers, 'id');
    if (id == null) throw new Error(`no server named ${name}`);
    // ACPI shutdown first: a snapshot taken with dirty pages in flight is a filesystem to fsck at boot.
    // The server is about to be deleted anyway, so a guest that ignores ACPI gets the plug pulled.
    await get(env, token, `/v1/servers/${String(id)}/actions/shutdown`, { method: 'POST' });
    let state = '';
    for (let i = 0; i < 60; i++) {
      state = await status(env, token, `/v1/servers/${String(id)}`, 'server');
      if (state === 'off') break;
      await sleep(5000, env);
    }
    if (state !== 'off') await get(env, token, `/v1/servers/${String(id)}/actions/poweroff`, { method: 'POST' });
    const made = await get(env, token, `/v1/servers/${String(id)}/actions/create_image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'snapshot', description: `node-ctl ${name}` }),
    });
    image = (made?.image as Image | undefined)?.id;
    if (image == null || image === '') throw new Error(`Hetzner returned no image for ${name}`);
  }
  // A full disk of some hundred GB takes its time; half an hour is what a stop is allowed to wait.
  for (let i = 0; i < 360; i++) {
    if ((await status(env, token, `/v1/images/${String(image)}`, 'image')) === 'available') return String(image);
    await sleep(5000, env);
  }
  throw new Error(`image ${String(image)} of ${name} is still being written; node-ctl stop ${name} waits for it again`);
}

// image.sh prune: every snapshot of the machine but the one to keep; say() gets each deletion.
export async function pruneImages(env: Env, token: string, name: string, keep: string, say: (line: string) => void): Promise<void> {
  for (const i of await snapshots(env, token, name)) {
    if (String(i.id) === keep) continue;
    await get(env, token, `/v1/images/${String(i.id)}`, { method: 'DELETE' });
    say(`deleted image ${String(i.id)}`);
  }
}
