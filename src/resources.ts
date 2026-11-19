// What the binary carries for the processes it runs (ADR-0022): both Terraform roots with their module and
// lock files, the scripts that run on a machine, and the node-ctl-migrate skill. Terraform reads real
// directories, so they are unpacked into NODE_CTL_HOME, in the checkout's layout.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import hetznerLock from '../terraform/.terraform.lock.hcl' with { type: 'text' };
import hetznerMain from '../terraform/main.tf' with { type: 'text' };
import hetznerOutputs from '../terraform/outputs.tf' with { type: 'text' };
import hetznerVariables from '../terraform/variables.tf' with { type: 'text' };
import hetznerVersions from '../terraform/versions.tf' with { type: 'text' };
import contaboLock from '../terraform/contabo/.terraform.lock.hcl' with { type: 'text' };
import contaboMain from '../terraform/contabo/main.tf' with { type: 'text' };
import contaboOutputs from '../terraform/contabo/outputs.tf' with { type: 'text' };
import contaboVariables from '../terraform/contabo/variables.tf' with { type: 'text' };
import contaboVersions from '../terraform/contabo/versions.tf' with { type: 'text' };
import cloudInit from '../terraform/modules/cloud-init/main.tf' with { type: 'text' };
import provision from '../scripts/provision.sh' with { type: 'text' };
import mountVolume from '../scripts/mount-volume.sh' with { type: 'text' };
import migrateSkill from '../skills/node-ctl-migrate/SKILL.md' with { type: 'text' };

// Path under NODE_CTL_HOME → contents. test/resources.test.ts holds it to the checkout's files.
export const RESOURCES: Record<string, string> = {
  'terraform/.terraform.lock.hcl': hetznerLock,
  'terraform/main.tf': hetznerMain,
  'terraform/outputs.tf': hetznerOutputs,
  'terraform/variables.tf': hetznerVariables,
  'terraform/versions.tf': hetznerVersions,
  'terraform/contabo/.terraform.lock.hcl': contaboLock,
  'terraform/contabo/main.tf': contaboMain,
  'terraform/contabo/outputs.tf': contaboOutputs,
  'terraform/contabo/variables.tf': contaboVariables,
  'terraform/contabo/versions.tf': contaboVersions,
  'terraform/modules/cloud-init/main.tf': cloudInit,
  'scripts/provision.sh': provision,
  'scripts/mount-volume.sh': mountVolume,
  'skills/node-ctl-migrate/SKILL.md': migrateSkill,
};

// Drops what an older version owned under the Terraform tree: every .tf (a file the new version no
// longer ships would still be loaded) and modules/ whole. State (terraform.tfstate.d/) and the provider
// cache (.terraform/) are never entered.
function dropOwned(dir: string): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'modules') rmSync(path, { recursive: true });
      else if (e.name !== '.terraform' && e.name !== 'terraform.tfstate.d') dropOwned(path);
    } else if (e.name.endsWith('.tf')) rmSync(path);
  }
}

// Unpacks when what is there came from other contents; true when it wrote. The version of the contents
// is recorded last, so an unpack cut short is done again by the next run.
export function unpack(home: string, files: Record<string, string> = RESOURCES): boolean {
  const version = Bun.hash(JSON.stringify(files)).toString(16);
  const mark = join(home, '.unpacked');
  if (existsSync(mark) && readFileSync(mark, 'utf8') === version) return false;
  dropOwned(join(home, 'terraform'));
  for (const [path, text] of Object.entries(files)) {
    const file = join(home, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    if (path.endsWith('.sh')) chmodSync(file, 0o755);
  }
  writeFileSync(mark, version);
  return true;
}
