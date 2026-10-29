import { basename, extname } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { graphPathSchema, type SourceLocation } from './model';

/** Shared cap used by both audit capture and the parser adapter. */
export const MAX_PARSER_SOURCE_BYTES = 1_000_000;

export interface ParsedSymbol {
  name: string;
  kind: 'function' | 'class' | 'test';
  source: SourceLocation;
}
export interface ParsedReference {
  target: string;
  relation: 'IMPORTS' | 'DEPENDS_ON' | 'TESTS' | 'CALLS';
  source: SourceLocation;
}
export interface ParseResult {
  language: string;
  symbols: ParsedSymbol[];
  references: ParsedReference[];
}
export interface ParserFailure {
  path: string;
  language: string;
  message: string;
}

const packageManifestSchema = z
  .object({
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

function source(path: string, line: number): SourceLocation {
  return { path, startLine: line, endLine: line };
}
function sourceNode(path: string, file: ts.SourceFile, node: ts.Node): SourceLocation {
  const start = node.getStart(file);
  return {
    path,
    startLine: file.getLineAndCharacterOfPosition(start).line + 1,
    endLine: file.getLineAndCharacterOfPosition(Math.max(start, node.getEnd() - 1)).line + 1,
  };
}
function firstSyntaxDiagnostic(file: ts.SourceFile): ts.Diagnostic | undefined {
  // The compiler API exposes this parser diagnostic array at runtime, though the
  // public SourceFile declaration intentionally omits the internal property.
  type SourceFileWithParserDiagnostics = ts.SourceFile & {
    readonly parseDiagnostics: readonly ts.Diagnostic[];
  };
  return (file as SourceFileWithParserDiagnostics).parseDiagnostics[0];
}
function lineMatches(pattern: RegExp, text: string): { match: RegExpExecArray; line: number }[] {
  const lines = text.split(/\r?\n/);
  const result: { match: RegExpExecArray; line: number }[] = [];
  for (const [index, line] of lines.entries()) {
    pattern.lastIndex = 0;
    const match = pattern.exec(line);
    if (match) result.push({ match, line: index + 1 });
  }
  return result;
}
function unique<T extends { name?: string; target?: string; source: SourceLocation }>(
  items: T[]
): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.name ?? item.target}:${item.source.startLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractionLimitFailure(
  path: string,
  language: string,
  symbols: readonly ParsedSymbol[],
  references: readonly ParsedReference[]
): ParserFailure | null {
  if (
    symbols.some((symbol) => Buffer.byteLength(symbol.name, 'utf8') > 1024) ||
    references.some((reference) => Buffer.byteLength(reference.target, 'utf8') > 256)
  ) {
    return {
      path,
      language,
      message: 'Source contains an extracted name or reference beyond the adapter limit.',
    };
  }
  return null;
}

/** Syntax-aware TypeScript/JavaScript extraction plus bounded Python and manifest adapters. */
export function parseSource(pathValue: string, content: string): ParseResult | ParserFailure {
  const path = graphPathSchema.parse(pathValue);
  if (content.includes('\0'))
    return { path, language: 'binary', message: 'Binary content is unsupported.' };
  if (Buffer.byteLength(content, 'utf8') > MAX_PARSER_SOURCE_BYTES)
    return { path, language: 'large-file', message: 'Source exceeds the 1 MiB parser limit.' };
  const extension = extname(path).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    const language = extension.includes('t') ? 'TypeScript' : 'JavaScript';
    const scriptKind = extension.endsWith('tsx')
      ? ts.ScriptKind.TSX
      : extension.endsWith('jsx')
        ? ts.ScriptKind.JSX
        : ['.js', '.mjs', '.cjs'].includes(extension)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
    const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind);
    const diagnostic = firstSyntaxDiagnostic(file);
    if (diagnostic) {
      return {
        path,
        language,
        message: `Parse error: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
      };
    }
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const addReference = (
      target: string,
      relation: ParsedReference['relation'],
      node: ts.Node
    ): void => {
      references.push({ target, relation, source: sourceNode(path, file, node) });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        symbols.push({
          name: node.name.text,
          kind: 'function',
          source: sourceNode(path, file, node),
        });
      } else if (ts.isClassDeclaration(node) && node.name) {
        symbols.push({ name: node.name.text, kind: 'class', source: sourceNode(path, file, node) });
      } else if (ts.isMethodDeclaration(node)) {
        symbols.push({
          name: node.name.getText(file),
          kind: 'function',
          source: sourceNode(path, file, node),
        });
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        symbols.push({
          name: node.name.text,
          kind: 'function',
          source: sourceNode(path, file, node),
        });
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        addReference(node.moduleSpecifier.text, 'IMPORTS', node);
      }
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const name = ts.isIdentifier(expression)
          ? expression.text
          : ts.isPropertyAccessExpression(expression)
            ? expression.name.text
            : null;
        const firstArgument = node.arguments[0];
        if (
          name &&
          ['it', 'test', 'describe'].includes(name) &&
          firstArgument &&
          ts.isStringLiteralLike(firstArgument)
        ) {
          symbols.push({
            name: firstArgument.text,
            kind: 'test',
            source: sourceNode(path, file, node),
          });
        } else if (
          (name === 'require' || expression.kind === ts.SyntaxKind.ImportKeyword) &&
          firstArgument &&
          ts.isStringLiteralLike(firstArgument)
        ) {
          addReference(firstArgument.text, 'IMPORTS', node);
        } else if (name && !['it', 'test', 'describe'].includes(name)) {
          addReference(name, 'CALLS', node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    const extractedSymbols = unique(symbols);
    const extractedReferences = unique(references);
    return (
      extractionLimitFailure(path, language, extractedSymbols, extractedReferences) ?? {
        language,
        symbols: extractedSymbols,
        references: extractedReferences,
      }
    );
  }
  if (extension === '.py') {
    const language = 'Python';
    const symbols = unique([
      ...lineMatches(/(?:async\s+)?def\s+([A-Za-z_][\w]*)/, content).map(({ match, line }) => ({
        name: match[1]!,
        kind: 'function' as const,
        source: source(path, line),
      })),
      ...lineMatches(/class\s+([A-Za-z_][\w]*)/, content).map(({ match, line }) => ({
        name: match[1]!,
        kind: 'class' as const,
        source: source(path, line),
      })),
    ]);
    const references = unique([
      ...lineMatches(/(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/, content).map(
        ({ match, line }) => ({
          target: match[1] ?? match[2]!,
          relation: 'IMPORTS' as const,
          source: source(path, line),
        })
      ),
    ]);
    return (
      extractionLimitFailure(path, language, symbols, references) ?? {
        language,
        symbols,
        references,
      }
    );
  }
  if (basename(path) === 'package.json') {
    try {
      const manifest = packageManifestSchema.parse(JSON.parse(content));
      const dependencies = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ];
      const references = unique(
        dependencies.map((target) => ({
          target,
          relation: 'DEPENDS_ON' as const,
          source: source(path, 1),
        }))
      );
      return (
        extractionLimitFailure(path, 'JSON', [], references) ?? {
          language: 'JSON',
          symbols: [],
          references,
        }
      );
    } catch {
      return { path, language: 'JSON', message: 'Invalid JSON manifest.' };
    }
  }
  return { path, language: extension || 'plain-text', message: 'No parser adapter is available.' };
}
