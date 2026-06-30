/**
 * Unified Parser Dispatcher — Routes files to language-specific AST parsers
 *
 * Languages supported:
 *   .js .jsx .mjs .cjs → acorn (JS parser)
 *   .ts .tsx           → @typescript-eslint/parser
 *   .py                → Python ast module (system Python)
 *   .go                → WASM tree-sitter (Go)
 *   .rs                → WASM tree-sitter (Rust)
 *   .java              → WASM tree-sitter (Java)
 */
import { parseFileAst as parseJS } from '../treewalker.js';
import { parseTypeScriptFile } from './typescript.js';
import { parsePythonFile } from './python.js';
import { parseWasmFile } from './wasmParser.js';

/**
 * Parse a file using the appropriate parser for its extension.
 * Returns { symbols: [...], imports: [...] }
 */
export async function parseFileAsync(filePath, baseDir) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const content = await readFileUtf8(filePath);

  try {
    switch (ext) {
      case 'ts':
      case 'tsx':
        return parseTypeScriptFile(filePath, baseDir);

      case 'py':
        return parsePythonFile(filePath, baseDir);

      case 'go':
      case 'rs':
      case 'java':
      case 'php':
      case 'c':
      case 'h':
      case 'cpp':
      case 'cc':
      case 'cxx':
      case 'hpp':
      case 'hh':
      case 'cs':
      case 'rb':
      case 'sh':
      case 'bash':
      case 'ps1':
      case 'psm1':
      case 'psd1':
        return await parseWasmFile(filePath, baseDir, content);

      case 'js':
      case 'jsx':
      case 'mjs':
      case 'cjs':
      default:
        return parseJS(filePath, baseDir);
    }
  } catch (e) {
    try {
      return parseJS(filePath, baseDir);
    } catch {
      return { symbols: [], imports: [] };
    }
  }
}

import fs from 'fs';

function readFileUtf8(filePath) {
  return fs.promises.readFile(filePath, 'utf-8');
}
