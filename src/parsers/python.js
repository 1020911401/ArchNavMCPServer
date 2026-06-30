/**
 * Python Parser — Python AST parsing via Python's built-in `ast` module
 * Spawns a Python helper script to produce clean JSON
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_SCRIPT = path.resolve(__dirname, '../../scripts/py_ast_parser.py');

/**
 * Parse a Python file by calling Python's ast module
 */
export function parsePythonFile(filePath, baseDir) {
  const relativePath = path.relative(baseDir, filePath);
  
  try {
    const output = execSync(
      `python "${PY_SCRIPT}" "${filePath}"`,
      { encoding: 'utf-8', timeout: 10000, maxBuffer: 5 * 1024 * 1024 }
    );
    
    const result = JSON.parse(output.trim());
    
    // Add file path to each symbol
    for (const sym of result.symbols || []) {
      sym.file = relativePath;
    }
    
    return result;
  } catch (e) {
    return parsePythonRegex(filePath, baseDir);
  }
}

/**
 * Fallback: regex-based Python parser when ast module fails
 */
function parsePythonRegex(filePath, baseDir) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const relativePath = path.relative(baseDir, filePath);
  const symbols = [];
  const imports = [];
  
  const funcRegex = /^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gm;
  const classRegex = /^class\s+(\w+)/gm;
  const importRegex = /^(?:from\s+(\S+)\s+)?import\s+(.+)$/gm;
  
  let match;
  while ((match = funcRegex.exec(content)) !== null) {
    const lineNum = getLineNum(content, match.index);
    symbols.push({
      id: match[1], name: match[1], kind: 'function',
      file: relativePath,
      line_start: lineNum, line_end: Math.min(lineNum + 50, lines.length),
      signature: `def ${match[1]}(${match[2]})`,
      params: match[2].split(',').map(p => p.trim()).filter(Boolean),
    });
  }
  
  while ((match = classRegex.exec(content)) !== null) {
    const lineNum = getLineNum(content, match.index);
    symbols.push({
      id: match[1], name: match[1], kind: 'class',
      file: relativePath,
      line_start: lineNum, line_end: Math.min(lineNum + 100, lines.length),
      signature: `class ${match[1]}`,
    });
  }
  
  while ((match = importRegex.exec(content)) !== null) {
    imports.push({
      source: match[1] || match[2].split(',')[0].trim(),
      specifiers: match[2].split(',').map(s => s.trim()),
      line: getLineNum(content, match.index),
    });
  }
  
  if (imports.length > 0 && symbols.length > 0) symbols[0].imports = imports;
  
  return { symbols, imports };
}

function getLineNum(content, index) {
  return content.substring(0, index).split('\n').length;
}
