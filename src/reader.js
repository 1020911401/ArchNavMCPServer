/**
 * Reader Module — Reads actual source code from disk (verification pattern)
 * This is the key innovation: always read actual code before modifying
 */
import fs from 'fs';
import path from 'path';
import { getIndex } from './analyzer.js';
import { checkStaleness, computeConfidence } from './confidence.js';

export async function readCode(name, dirPath, options = {}) {
  // First, locate the symbol using the index
  const index = getIndex(dirPath);
  
  if (!index) {
    return { 
      type: 'read', 
      error: 'No index found. Run "archnav analyze ." first',
      code: null, 
      confidence: 0,
    };
  }
  
  // Find the symbol in the index
  const matches = index.symbols.filter(s => 
    s.name === name || s.name.toLowerCase().includes(name.toLowerCase())
  );
  
  if (matches.length === 0) {
    // Fallback: grep the codebase for the name
    return await fallbackRead(name, dirPath, options);
  }
  
  const sym = matches[0];
  const freshness = await checkStaleness(dirPath);
  const confidence = computeConfidence(sym.file, index.fileHashes, freshness, dirPath);
  
  // READ FROM DISK — not from the index!
  const fullPath = path.resolve(dirPath, sym.file);
  
  if (!fs.existsSync(fullPath)) {
    return {
      type: 'read',
      code: null,
      file: sym.file,
      line_start: sym.line_start,
      line_end: sym.line_end,
      confidence: 0,
      warning: 'File no longer exists on disk (index is stale)',
    };
  }
  
  const fileContent = fs.readFileSync(fullPath, 'utf-8');
  const fileLines = fileContent.split('\n');
  
  // Extract the exact lines for this symbol
  const startLine = Math.max(0, sym.line_start - 1);
  const endLine = Math.min(fileLines.length, sym.line_end);
  const codeLines = fileLines.slice(startLine, endLine);
  
  // Verify the function signature still matches
  const firstLine = codeLines[0]?.trim() || '';
  const expectedSignature = sym.signature || sym.name;
  const signatureMatch = firstLine.includes(sym.name);
  
  // Adjust confidence based on signature match
  const adjustedConfidence = signatureMatch ? confidence : confidence * 0.5;
  
  if (options.lines) {
    return {
      type: 'read',
      code: codeLines.join('\n'),
      file: sym.file,
      line_start: sym.line_start,
      line_end: sym.line_start + codeLines.length - 1,
      confidence: adjustedConfidence,
      signature_confirmed: signatureMatch,
      lines: true,
    };
  }
  
  return {
    type: 'read',
    code: codeLines.join('\n'),
    file: sym.file,
    line_start: sym.line_start,
    line_end: sym.line_start + codeLines.length - 1,
    confidence: adjustedConfidence,
    signature_confirmed: signatureMatch,
  };
}

async function fallbackRead(name, dirPath, options) {
  // Grep the codebase
  const { execSync } = await import('child_process');
  
  try {
    const grepResult = execSync(
      `grep -rn "function\\s*${name}\\|${name}\\s*=\\s*function\\|${name}\\s*=\\s*(async\\s*)?(" "${dirPath}/src" --include="*.js" 2>/dev/null | head -5`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    
    if (!grepResult.trim()) {
      return { type: 'read', code: null, confidence: 0, error: `Symbol "${name}" not found via search` };
    }
    
    const lines = grepResult.trim().split('\n');
    const firstMatch = lines[0];
    const matchParts = firstMatch.split(':');
    const relFile = path.relative(dirPath, matchParts[0]);
    const matchLine = parseInt(matchParts[1]);
    
    // Read the surrounding code
    const fullPath = path.resolve(dirPath, relFile);
    const fileContent = fs.readFileSync(fullPath, 'utf-8').split('\n');
    const startLine = Math.max(0, matchLine - 1);
    const endLine = Math.min(fileContent.length, matchLine + 30);
    const codeLines = fileContent.slice(startLine, endLine);
    
    return {
      type: 'read',
      code: codeLines.join('\n'),
      file: relFile,
      line_start: matchLine,
      line_end: matchLine + codeLines.length - 1,
      confidence: 0.3, // Low confidence — grep-based, no index
      source: 'grep-fallback',
    };
  } catch {
    return { type: 'read', code: null, confidence: 0, error: `Symbol "${name}" not found anywhere` };
  }
}
