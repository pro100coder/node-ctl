import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { paths } from '../src/paths.ts';
import { RESOURCES, unpack } from '../src/resources.ts';

const fresh = () => mkdtempSync(join(tmpdir(), 'node-ctl-home-'));
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const read = (home: string, path: string) => readFileSync(join(home, path), 'utf8');

test('the first unpack writes every embedded file where the checkout had it; scripts are executable', () => {
  const home = fresh();
  expect(unpack(home)).toBe(true);
  for (const [path, text] of Object.entries(RESOURCES)) expect(read(home, path)).toBe(text);
  expect(statSync(join(home, 'scripts/provision.sh')).mode & 0o111).toBe(0o111);
});

test('the relative paths in the roots still meet: the module finds the machine scripts, both roots the default inventory', () => {
  const home = fresh();
  unpack(home);
  const module = join(home, 'terraform/modules/cloud-init');
  expect(read(home, 'terraform/modules/cloud-init/main.tf')).toContain('${path.module}/../../../scripts/provision.sh');
  expect(existsSync(join(module, '../../../scripts/provision.sh'))).toBe(true);
  expect(existsSync(join(module, '../../../scripts/mount-volume.sh'))).toBe(true);
  const servers = paths({ HOME: '/u', NODE_CTL_HOME: home }).servers;
  expect(read(home, 'terraform/main.tf')).toContain('"${path.module}/../servers"');
  expect(join(home, 'terraform', '../servers')).toBe(servers);
  expect(read(home, 'terraform/contabo/main.tf')).toContain('"${path.module}/../../servers"');
  expect(join(home, 'terraform/contabo', '../../servers')).toBe(servers);
});

test('a new version rewrites what the release owns, drops the .tf files it no longer ships, and never touches state or the provider cache', () => {
  const home = fresh();
  unpack(home);
  // what Terraform and the user put next to the roots
  const kept: Record<string, string> = {
    'terraform/terraform.tfstate.d/main/terraform.tfstate': '{"serial": 7}',
    'terraform/terraform.tfstate.d/main/terraform.tfstate.backup': '{"serial": 6}',
    'terraform/contabo/terraform.tfstate.d/acme/terraform.tfstate': '{"serial": 3}',
    'terraform/terraform.tfstate.d/modules/terraform.tfstate': '{"serial": 2}', // an account tagged modules
    'terraform/.terraform/environment': 'main',
    'terraform/.terraform/modules/modules.json': '{}',
    'terraform/.terraform/modules/cloud_init/main.tf': 'a cached module copy',
    'terraform/contabo/.terraform/providers/x/terraform-provider-contabo': 'binary',
    'servers/dev1.json': '{"state":"running"}',
    'node-ctl.yaml': 'hetzner: {}',
  };
  for (const [path, text] of Object.entries(kept)) put(join(home, path), text);
  put(join(home, 'terraform/override.tf'), 'stale: shipped by no version'); // gone: Terraform would load it
  put(join(home, 'terraform/modules/cloud-init/old.tf'), 'stale module file');
  put(join(home, 'terraform/modules/old-module/template.yaml'), 'modules/ is replaced whole');

  // the next version: one .tf less in each root, new content elsewhere
  const next = { ...RESOURCES };
  delete next['terraform/outputs.tf'];
  delete next['terraform/contabo/outputs.tf'];
  next['terraform/main.tf'] = '# v2\n';
  next['terraform/.terraform.lock.hcl'] = '# v2 lock\n';
  next['terraform/modules/cloud-init/main.tf'] = '# v2 module\n';
  next['scripts/provision.sh'] = '#!/usr/bin/env bash\n# v2\n';
  expect(unpack(home, next)).toBe(true);

  for (const [path, text] of Object.entries(kept)) expect(read(home, path)).toBe(text);
  for (const gone of ['terraform/outputs.tf', 'terraform/contabo/outputs.tf', 'terraform/override.tf', 'terraform/modules/cloud-init/old.tf', 'terraform/modules/old-module']) {
    expect(existsSync(join(home, gone))).toBe(false);
  }
  for (const [path, text] of Object.entries(next)) expect(read(home, path)).toBe(text);
});

test('the same version unpacks nothing: a run does not rewrite the roots every time', () => {
  const home = fresh();
  unpack(home);
  writeFileSync(join(home, 'terraform/main.tf'), '# edited by hand');
  expect(unpack(home)).toBe(false);
  expect(read(home, 'terraform/main.tf')).toBe('# edited by hand');
});

test('an unpack cut short is done again: the version is recorded last', () => {
  const home = fresh();
  mkdirSync(join(home, 'scripts/provision.sh'), { recursive: true }); // a directory where a file goes: the write fails
  expect(() => unpack(home)).toThrow();
  rmSync(join(home, 'scripts/provision.sh'), { recursive: true });
  expect(unpack(home)).toBe(true);
  expect(read(home, 'scripts/provision.sh')).toBe(RESOURCES['scripts/provision.sh']!);
});

test('everything Terraform and cloud-init read is embedded: every root and module file of the checkout, the machine scripts', () => {
  const root = join(import.meta.dir, '..');
  const tracked = [...new Bun.Glob('terraform/**/{*.tf,.terraform.lock.hcl}').scanSync({ cwd: root, dot: true })].filter(
    (p) => !/(^|\/)(tests|\.terraform|terraform\.tfstate\.d)\//.test(p),
  );
  expect(tracked.length).toBeGreaterThan(8);
  const wanted = [...tracked, 'scripts/provision.sh', 'scripts/mount-volume.sh', 'skills/node-ctl-migrate/SKILL.md'];
  expect(Object.keys(RESOURCES).sort()).toEqual(wanted.sort());
  for (const path of wanted) expect(RESOURCES[path]).toBe(readFileSync(join(root, path), 'utf8'));
});
