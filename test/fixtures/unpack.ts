// Compiled by test/build.test.ts: the embedded files must survive bun build --compile, not only bun test.
import { unpack } from '../../src/resources.ts';

unpack(process.argv[2]!);
