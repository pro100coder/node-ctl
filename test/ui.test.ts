import { expect, test } from 'bun:test';
import { UserError } from '../src/errors.ts';
import { ask, confirm, Input, menu, menuList, yesNo, type Menu, type Ui } from '../src/ui.ts';
import { Sink } from './helpers.ts';

// What stdin holds, handed over in the given pieces (a terminal sends a key at a time).
const input = (pieces: string[], terminal = false) => {
  const queue = pieces.map((p) => new TextEncoder().encode(p));
  return new Input(terminal, async () => queue.shift());
};
const ui = (stdin: string | string[], over: Partial<Ui> = {}) => {
  const stderr = new Sink();
  const modes: boolean[] = [];
  let suspended = 0;
  const u: Ui = {
    input: input(typeof stdin === 'string' ? [stdin] : stdin),
    stderr,
    yes: false,
    home: '/home/u',
    drawn: false,
    color: false,
    columns: 80,
    rows: 24,
    suspend: () => suspended++,
    raw: (on) => modes.push(on),
    ...over,
  };
  return { u, stderr, modes, suspended: () => suspended };
};
const ACCOUNTS: Menu = menuList('main main (hetzner)\nwork work (hetzner)\n');

test('menuList takes the first word of each line as its value and shows the line', () => {
  expect(ACCOUNTS).toEqual({ values: ['main', 'work'], lines: [' main main (hetzner)', ' work work (hetzner)'] });
});

test('off a terminal a menu is the numbered list on stderr and one typed line: a number, the value itself, or empty for the default', async () => {
  const t = ui('2\n');
  expect(await menu(t.u, 'account', ACCOUNTS)).toBe('work');
  expect(t.stderr.text).toBe('   1) main main (hetzner)\n   2) work work (hetzner)\n'); // read -p prompts only on a terminal
  expect(await menu(ui('\n').u, 'account', ACCOUNTS, 'work')).toBe('work');
  expect(await menu(ui('  nope \n').u, 'account', ACCOUNTS)).toBe('nope'); // the caller judges an answer off the list
  expect(await menu(ui('7\n').u, 'account', ACCOUNTS)).toBe(''); // past the list: nothing
  expect(await menu(ui('0\n').u, 'account', ACCOUNTS)).toBe('');
});

test('a header heads the list, and the prompt shows the default when stdin is a terminal', async () => {
  const t = ui('1\n', { input: input(['1\n'], true) });
  await menu(t.u, 'type', { ...ACCOUNTS, header: 'NAME  ACCOUNT' }, 'work');
  expect(t.stderr.text).toBe('\n     NAME  ACCOUNT\n   1) main main (hetzner)\n   2) work work (hetzner)\ntype or number [work]: ');
});

test('a menu is cancelled by the end of input, even after a typed answer with no newline, and when nothing can be picked', async () => {
  expect(await menu(ui('').u, 'account', ACCOUNTS)).toBeUndefined();
  expect(await menu(ui('2').u, 'account', ACCOUNTS)).toBeUndefined();
  expect(await menu(ui('1\n').u, 'account', { ...ACCOUNTS, skip: [1, 2] })).toBeUndefined();
});

test('the default skips lines that cannot be picked; with none pickable, an empty answer is nothing', async () => {
  expect(await menu(ui('\n').u, 'type', { values: ['a', 'b', 'c'], lines: [' a', ' b', ' c'], skip: [1] })).toBe('b');
  expect(await menu(ui('\n').u, 'size', { values: ['a'], lines: [' a'], skip: [1], any: 'type one' })).toBe('');
});

test('a second question reads the next line: answers come one per question', async () => {
  const t = ui(['2\nyes\n']);
  expect(await menu(t.u, 'account', ACCOUNTS)).toBe('work');
  expect(await yesNo(t.u, 'Grow the disk?')).toBe(true);
});

test('yes/no is no unless yes is picked or typed (y, Y, yes); cancelling is no', async () => {
  for (const [typed, answer] of [['2\n', true], ['y\n', true], ['Y\n', true], ['yes\n', true], ['\n', false], ['n\n', false], ['', false]] as const) {
    expect(await yesNo(ui(typed).u, 'Grow the disk?')).toBe(answer);
  }
});

test('confirm: --yes answers it anywhere; otherwise only the exact word typed on a terminal goes on', async () => {
  await confirm(ui('', { yes: true }).u, 'Destroy dev1?', 'dev1');
  await expect(confirm(ui('dev1\n').u, 'Destroy dev1?', 'dev1')).rejects.toThrow(new UserError('no terminal to confirm on; pass --yes'));
  const t = ui('', { input: input([' dev1 \n'], true) });
  await confirm(t.u, 'Destroy dev1?', 'dev1');
  expect(t.stderr.text).toBe('Destroy dev1? Type dev1 to confirm: ');
  await expect(confirm(ui('', { input: input(['dev2\n'], true) }).u, 'Destroy dev1?', 'dev1')).rejects.toThrow(new UserError('aborted'));
  await expect(confirm(ui('', { input: input([''], true) }).u, 'Destroy dev1?', 'dev1')).rejects.toThrow(new UserError('aborted'));
});

test('ask shows the hint, keeps the current value on an empty answer, expands a leading ~, and dies at the end of input', async () => {
  const t = ui('\n~/.ssh/k.pub\n');
  expect(await ask(t.u, 'TAG', 'A tag for this account', 'main')).toBe('main');
  expect(await ask(t.u, 'KEY', 'Public key', '')).toBe('/home/u/.ssh/k.pub');
  expect(t.stderr.text).toBe('\nA tag for this account\n\nPublic key\n');
  expect(t.suspended()).toBe(2); // the live region is closed before each question
  await expect(ask(ui('').u, 'TAG', 'hint')).rejects.toThrow(new UserError('aborted'));
});

test('a secret is asked unechoed on a terminal, its current value never shown; backspace edits', async () => {
  const t = ui('', { input: input(['s', 'x', '\x7f', '3', '\r'], true) });
  expect(await ask(t.u, 'TOKEN', 'The API token', 'old-secret', true)).toBe('s3');
  expect(t.stderr.text).toBe('\nThe API token\nTOKEN [(set)]: \n');
  expect(t.modes).toEqual([true, false]);
  expect(await ask(ui('\n').u, 'TOKEN', 'hint', 'old-secret', true)).toBe('old-secret');
});

// --- the drawn menu: keys on a terminal ----------------------------------------------------------

const drawn = (keys: string[], over: Partial<Ui> = {}) => ui('', { drawn: true, input: input(keys, true), ...over });
const LIST: Menu = { values: ['a', 'b', 'c', 'd'], lines: [' a', ' b', ' c', ' d'] };

test('a drawn menu: arrows and j/k move, enter picks, and the answer replaces the window', async () => {
  const t = drawn(['\x1b[B', 'j', 'k', '\x1b[B', '\r']);
  expect(await menu(t.u, 'pick', LIST)).toBe('c');
  expect(t.modes).toEqual([true, false]); // raw only while the window is up
  expect(t.suspended()).toBe(1);
  const text = t.stderr.text;
  expect(text.startsWith('? pick\n')).toBe(true);
  expect(text).toContain(' >  a\x1b[K\n'); // the line keeps its leading blank
  expect(text).toContain('↑↓ move · enter picks · q cancels (3/4)');
  expect(text.endsWith('\x1b[6A\x1b[J  pick: c\n')).toBe(true); // 4 lines, the footer and the question go
});

test('a drawn menu walks past lines it cannot pick, stays put at an end, and q or ^D cancels', async () => {
  expect(await menu(drawn(['j', '\r']).u, 'pick', { ...LIST, skip: [2, 3] })).toBe('d');
  expect(await menu(drawn(['k', 'k', '\r']).u, 'pick', LIST)).toBe('a');
  expect(await menu(drawn(['\x1b[6~', '\r']).u, 'pick', LIST)).toBe('d'); // a page down is the window's height
  expect(await menu(drawn(['q']).u, 'pick', LIST)).toBeUndefined();
  expect(await menu(drawn(['\x04']).u, 'pick', LIST)).toBeUndefined();
});

test('a drawn menu opens on the preset; its last line can ask for an answer the list does not have', async () => {
  expect(await menu(drawn(['\r']).u, 'pick', LIST, 'c')).toBe('c');
  const t = drawn(['j', 'j', 'j', 'j', '\n', 'V999\n']);
  expect(await menu(t.u, 'product', { ...LIST, any: 'another product: type it' })).toBe('V999');
  expect(t.stderr.text).toContain('   another product: type it\x1b[K\n');
  expect(t.stderr.text.endsWith('  product: another product: type it\n  product: ')).toBe(true);
});

test('a drawn line is cut to the terminal, and the hint leads the footer; colour marks the question and the selection', async () => {
  const t = drawn(['\r'], { columns: 54, color: true });
  await menu(t.u, 'type', { values: ['x'], lines: [` ${'y'.repeat(80)}`], hint: '* not here' });
  expect(t.stderr.text).toContain(`\x1b[7m >  ${'y'.repeat(49)}\x1b[0m\x1b[K\n`);
  expect(t.stderr.text).toContain('\x1b[1m?\x1b[0m type\n');
  expect(t.stderr.text).toContain('* not here · ↑↓ move');
});
