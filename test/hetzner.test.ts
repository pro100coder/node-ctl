// The tariff lists create and resize ask from, held to what scripts/server-types.sh printed for the same
// answer (the bats test "the create price list is what a location will take, not what it prices").
import { expect, test } from 'bun:test';
import { createRows, moveRows, type TypeRow } from '../src/hetzner.ts';

const TYPES = JSON.parse(`[
  {"id":4,"name":"cx33","cores":8,"memory":16,"disk":80,"cpu_type":"shared",
   "locations":[{"name":"nbg1","available":false},{"name":"fsn1","available":false}],
   "prices":[{"location":"nbg1","price_monthly":{"gross":"16.9000"}},{"location":"fsn1","price_monthly":{"gross":"16.4000"}}]},
  {"id":9,"name":"cax21","cores":4,"memory":8,"disk":80,"cpu_type":"arm",
   "locations":[{"name":"nbg1","available":true},{"name":"fsn1","available":false}],
   "prices":[{"location":"nbg1","price_monthly":{"gross":"6.9900"}},{"location":"fsn1","price_monthly":{"gross":"6.9900"}}]},
  {"id":1,"name":"cx22","cores":2,"memory":4,"disk":40,"cpu_type":"shared",
   "locations":[{"name":"nbg1","available":true},{"name":"fsn1","available":true}],
   "prices":[{"location":"nbg1","price_monthly":{"gross":"4.5100"}},{"location":"fsn1","price_monthly":{"gross":"4.5100"}}]},
  {"id":7,"name":"cx11","cores":1,"memory":2,"disk":20,"cpu_type":"shared","deprecation":{"unavailable_after":"2024-01-01"},
   "locations":[{"name":"nbg1","available":true}],
   "prices":[{"location":"nbg1","price_monthly":{"gross":"3.0000"}}]}]`);

const tsv = (rows: TypeRow[]) =>
  rows
    .sort((a, b) => a.price - b.price)
    .map((r) => [r.name, r.cores, r.memory, r.cpu, r.disk, r.price, r.last].join('\t'))
    .join('\n');

test('a create lists what a location will create now, not what it prices, cheapest first and never a deprecated type', () => {
  expect(tsv(createRows(TYPES))).toBe('cx22\t2\t4\tshared\t40\t4.51\tfsn1,nbg1\ncax21\t4\t8\tarm\t80\t6.99\tnbg1');
});

test('a move lists every type priced in the location; yes only where it is available and holds the disk', () => {
  expect(tsv(moveRows(TYPES, 'nbg1', 'cx22', 60))).toBe(
    'cx11\t1\t2\tshared\t20\t3\tno\ncx22\t2\t4\tshared\t40\t4.51\tno\ncax21\t4\t8\tarm\t80\t6.99\tyes\ncx33\t8\t16\tshared\t80\t16.9\tno',
  );
  expect(moveRows(TYPES, 'nbg1', 'cx22').find((r) => r.name === 'cx22')!.last).toBe('yes'); // its own disk by default
  expect(() => moveRows(TYPES, 'nbg1', 'cx99')).toThrow('unknown server type: cx99');
});

test('a machine moves only within its architecture', () => {
  const arm = TYPES.map((t: Record<string, unknown>) => ({ ...t, architecture: t.cpu_type === 'arm' ? 'arm' : 'x86' }));
  expect(moveRows(arm, 'nbg1', 'cx22').map((r) => r.name)).toEqual(['cx33', 'cx22', 'cx11']);
});
