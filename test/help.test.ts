import { expect, test } from 'bun:test';
import { COMMANDS } from '../src/cli.ts';
import { PAGES, USAGE } from '../src/help.ts';

test('there is a page for every dispatched command and help, and none for anything else', () => {
  expect(Object.keys(PAGES).sort()).toEqual([...COMMANDS, 'help'].sort());
});

test('the usage lists every dispatched command, each at the start of its own line', () => {
  const listed = USAGE.split('\n').flatMap((l) => /^ {2}([a-z]+)\b/.exec(l)?.[1] ?? []);
  expect([...new Set(listed)].sort()).toEqual([...COMMANDS].sort());
});

test('help describes the binary on PATH, not the bash checkout it replaced', () => {
  const all = [USAGE, ...Object.values(PAGES)].join('\n');
  expect(all).not.toContain('./node-ctl');
  expect(all).not.toContain('BIN_DIR');
  expect(PAGES.check).not.toMatch(/\b(jq|yq|curl|uuidgen)\b|\bnode\b(?!-)/);
  expect(PAGES.init).not.toMatch(/link +node-ctl/);
  for (const c of ['start', 'autostop']) {
    expect(PAGES[c]).toMatch(/launchd[\s\S]*macOS|macOS[\s\S]*launchd/);
    expect(PAGES[c]).toMatch(/systemd\s+user timer/);
  }
});

// The texts themselves: a change to what help prints shows up in the snapshot's diff, where it is reviewed.
test('the usage and every page read as recorded', () => {
  expect(USAGE).toMatchSnapshot();
  for (const c of Object.keys(PAGES).sort()) expect(PAGES[c]).toMatchSnapshot(c);
});
