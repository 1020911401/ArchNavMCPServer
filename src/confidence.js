/**
 * Confidence Module — Staleness detection and confidence scoring
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

/**
 * Check staleness of the index vs current code on disk
 */
export async function checkStaleness(dirPath) {
  const result = {
    stale: false,
    overallConfidence: 1.0,
    indexedCommit: null,
    currentHead: null,
    changedFiles: 0,
    indexAge: null,
    changedDetails: [],
  };
  
  // Check git commit comparison
  try {
    const gitDir = path.join(dirPath, '.git');
    const headFile = path.join(gitDir, 'HEAD');
    const archnavCommitFile = path.join(dirPath, '.archnav', 'commit');
    
    if (fs.existsSync(headFile) && fs.existsSync(archnavCommitFile)) {
      const headContent = fs.readFileSync(headFile, 'utf-8').trim();
      let currentCommit = headContent;
      if (headContent.startsWith('ref: ')) {
        const refPath = headContent.substring(5);
        currentCommit = fs.readFileSync(path.join(gitDir, refPath), 'utf-8').trim();
      }
      
      const indexedCommit = fs.readFileSync(archnavCommitFile, 'utf-8').trim();
      
      result.indexedCommit = indexedCommit;
      result.currentHead = currentCommit;
      
      // Compare commits
      if (currentCommit !== indexedCommit) {
        result.stale = true;
        result.overallConfidence = 0.5;
        
        // Count changed files
        try {
          const execSync = (await import('child_process')).execSync;
          const diffOutput = execSync(
            `git diff --name-only ${indexedCommit.substring(0, 8)}..HEAD 2>/dev/null || git diff --name-only HEAD 2>/dev/null`,
            { cwd: dirPath, encoding: 'utf-8', timeout: 5000 }
          );
          const changedFiles = diffOutput.split('\n').filter(Boolean);
          result.changedFiles = changedFiles.length;
          result.changedDetails = changedFiles.map(f => ({ file: f, symbolsAffected: 0 }));
        } catch {}
      }
    }
    
    // Calculate index age
    const indexFile = path.join(dirPath, '.archnav', 'index.json');
    if (fs.existsSync(indexFile)) {
      const stat = fs.statSync(indexFile);
      const ageMs = Date.now() - stat.mtimeMs;
      const ageHours = ageMs / 3600000;
      result.indexAge = ageHours < 1 
        ? `${Math.round(ageMs / 60000)}m` 
        : ageHours < 24 
          ? `${Math.round(ageHours)}h` 
          : `${Math.round(ageHours / 24)}d`;
    }
  } catch (e) {
    // Not a git repo or other issue - use file hash comparison as fallback
    result.warnings = [`Staleness check limited: ${e.message}`];
  }
  
  return result;
}

/**
 * Compute confidence for a specific symbol/file
 */
export function computeConfidence(symbolFile, fileHashes, freshness, dirPath) {
  // Start with baseline confidence
  let confidence = 1.0;
  
  // Factor 1: Overall index staleness
  if (freshness.stale) {
    confidence -= 0.3;
  }
  
  // Factor 2: Check if this specific file has changed
  if (fileHashes && dirPath) {
    const currentFilePath = path.join(dirPath, symbolFile);
    try {
      if (fs.existsSync(currentFilePath)) {
        const currentContent = fs.readFileSync(currentFilePath, 'utf-8');
        const currentHash = createHash('sha256').update(currentContent).digest('hex').substring(0, 12);
        const indexedHash = fileHashes[symbolFile];
        
        if (indexedHash && currentHash !== indexedHash) {
          confidence -= 0.4; // File has changed significantly
        }
      } else {
        confidence -= 0.8; // File no longer exists!
      }
    } catch {
      confidence -= 0.2; // Can't verify
    }
  }
  
  // Factor 3: Index age penalty
  if (freshness.indexAge) {
    const ageMatch = freshness.indexAge.match(/(\d+)([mhd])/);
    if (ageMatch) {
      const value = parseInt(ageMatch[1]);
      const unit = ageMatch[2];
      if (unit === 'd') confidence -= Math.min(value * 0.05, 0.2);
      else if (unit === 'h') confidence -= Math.min(value * 0.01, 0.1);
    }
  }
  
  return Math.max(0, Math.min(1, confidence));
}
