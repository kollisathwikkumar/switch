import { describe, expect, it } from 'vitest';
import { MAX_PARSER_SOURCE_BYTES, parseSource } from './parser-adapters';

describe('TraceMind parser adapters', () => {
  it('applies the shared parser byte limit exactly at its boundary', () => {
    const atLimit = parseSource('src/at-limit.ts', ' '.repeat(MAX_PARSER_SOURCE_BYTES));
    expect(atLimit).toMatchObject({ language: 'TypeScript', symbols: [], references: [] });
    expect(
      parseSource('src/over-limit.ts', `${' '.repeat(MAX_PARSER_SOURCE_BYTES)} `)
    ).toMatchObject({
      language: 'large-file',
      message: 'Source exceeds the 1 MiB parser limit.',
    });
  });

  it('extracts TypeScript symbols, imports, calls and tests with source locations', () => {
    const result = parseSource(
      'src/a.test.ts',
      "import { x } from './x';\nexport function run() { x(); }\nit('works', () => run());"
    );
    if ('message' in result) throw new Error(result.message);
    expect(result.language).toBe('TypeScript');
    expect(result.symbols).toEqual(
      expect.arrayContaining([
        {
          name: 'run',
          kind: 'function',
          source: { path: 'src/a.test.ts', startLine: 2, endLine: 2 },
        },
        {
          name: 'works',
          kind: 'test',
          source: { path: 'src/a.test.ts', startLine: 3, endLine: 3 },
        },
      ])
    );
    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: './x', relation: 'IMPORTS' }),
        expect.objectContaining({ target: 'x', relation: 'CALLS' }),
      ])
    );
  });
  it('reports unsupported and invalid sources instead of inventing relationships', () => {
    expect(parseSource('README.md', 'text')).toMatchObject({
      path: 'README.md',
      message: 'No parser adapter is available.',
    });
    expect(parseSource('package.json', '{')).toMatchObject({
      path: 'package.json',
      message: 'Invalid JSON manifest.',
    });
    expect(
      parseSource('package.json', JSON.stringify({ dependencies: 'not-a-dependency-map' }))
    ).toMatchObject({
      path: 'package.json',
      message: 'Invalid JSON manifest.',
    });
  });

  it('reports extracted references that exceed persisted graph field limits', () => {
    expect(parseSource('src/long.ts', `import './${'x'.repeat(257)}';`)).toMatchObject({
      path: 'src/long.ts',
      language: 'TypeScript',
      message: 'Source contains an extracted name or reference beyond the adapter limit.',
    });
  });

  it('uses syntax-aware TypeScript extraction and reports syntax diagnostics', () => {
    const parsed = parseSource(
      'src/syntax.ts',
      '// function ghost() { hidden(); }\nexport function actual() { helper(); }\nconst lambda = () => actual();\nconst text = "phantom()";'
    );
    if ('message' in parsed) throw new Error(parsed.message);
    expect(parsed.symbols.map((symbol) => symbol.name)).toEqual(['actual', 'lambda']);
    expect(parsed.references.map((reference) => reference.target)).toEqual(['helper', 'actual']);
    expect(parseSource('src/broken.ts', 'export function broken( {')).toMatchObject({
      path: 'src/broken.ts',
      language: 'TypeScript',
      message: expect.stringContaining('Parse error'),
    });
  });
});
