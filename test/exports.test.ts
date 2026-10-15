import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  exports: Record<string, string | Record<string, string>>;
};
const entries = Object.entries(pkg.exports).filter((entry): entry is [string, Record<string, string>] => typeof entry[1] === 'object');

describe('package exports', () => {
  it('every entry has a default condition, so require() resolves too', () => {
    for (const [subpath, conditions] of entries) {
      expect(conditions.default, subpath).toBe(conditions.import);
      // Conditions match in order; default must come last.
      expect(Object.keys(conditions).at(-1), subpath).toBe('default');
    }
  });

  // Loads the committed build through the package's own name, as a CommonJS app would.
  it.skipIf(!existsSync(new URL('../dist/server.js', import.meta.url)))('require() loads the server entry', () => {
    const require = createRequire(import.meta.url);
    for (const [subpath] of entries) {
      expect(() => require.resolve(`${pkg.name}${subpath.slice(1)}`), subpath).not.toThrow();
    }
    const server = require(`${pkg.name}/server`) as Record<string, unknown>;
    expect(typeof server.createAssistantHandler).toBe('function');
  });
});
