/**
 * TreeWalker — AST-based code parser using acorn (pure JS, zero native deps)
 * Replaces the regex-based analyzer with tree-sitter quality parsing
 */
import * as acorn from 'acorn';
import * as acornLoose from 'acorn-loose';
import fs from 'fs';
import path from 'path';

/**
 * Parse a JS/TS file and extract all symbols with exact line ranges
 */
export function parseFileAst(filePath, baseDir) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const relativePath = path.relative(baseDir, filePath);
  const symbols = [];
  const imports = [];
  const exports = [];

  let ast;
  try {
    ast = acorn.parse(content, {
      ecmaVersion: 2022,
      sourceType: 'module',
      locations: true,
      ranges: true,
      allowImportExportEverywhere: true,
    });
  } catch (e) {
    // Fallback to loose mode for JS with common extensions
    try {
      ast = acornLoose.parse(content, {
        ecmaVersion: 2022,
        sourceType: 'script',
        locations: true,
        ranges: true,
      });
    } catch {
      // If both fail, return empty — better than wrong data
      return { symbols: [], imports: [], exports: [] };
    }
  }

  // Walk the AST
  walkNode(ast, null, (node, parent, grandparent) => {
    switch (node.type) {
      // === Function declarations ===
      case 'FunctionDeclaration': {
        if (node.id) {
          symbols.push({
            id: node.id.name,
            name: node.id.name,
            kind: 'function',
            file: relativePath,
            line_start: node.loc.start.line,
            line_end: node.loc.end.line,
            signature: extractSignature(content, node),
            params: (node.params || []).map(p => extractParamName(p)),
            exported: isExported(node, parent),
            async: node.async || false,
            generator: node.generator || false,
          });
        }
        break;
      }

      // === Arrow / Function expressions assigned to variables ===
      case 'VariableDeclarator': {
        if (node.id?.type === 'Identifier' && 
            (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')) {
          symbols.push({
            id: node.id.name,
            name: node.id.name,
            kind: 'function',
            file: relativePath,
            line_start: node.loc.start.line,
            line_end: node.loc.end.line,
            signature: `${node.id.name} = (${(node.init.params || []).map(p => extractParamName(p)).join(', ')}) =>`,
            params: (node.init.params || []).map(p => extractParamName(p)),
            exported: isExported(node, parent),
            async: node.init.async || false,
          });
        }
        break;
      }

      // === Class declarations ===
      case 'ClassDeclaration': {
        if (node.id) {
          const superClass = node.superClass?.type === 'Identifier' ? node.superClass.name : 
                            node.superClass?.type === 'MemberExpression' ? extractMemberExpr(node.superClass) : null;
          symbols.push({
            id: node.id.name,
            name: node.id.name,
            kind: 'class',
            file: relativePath,
            line_start: node.loc.start.line,
            line_end: node.loc.end.line,
            signature: `class ${node.id.name}${superClass ? ` extends ${superClass}` : ''}`,
            superClass,
            exported: isExported(node, parent),
          });
        }
        break;
      }

      // === Object methods (inside objects/classes) ===
      case 'Property':
      case 'MethodDefinition': {
        const isMethod = node.type === 'MethodDefinition' || 
                        (node.type === 'Property' && node.method);
        if (isMethod && node.key?.type === 'Identifier' && node.value?.type === 'FunctionExpression') {
          const methodName = node.key.name;
          const func = node.value;
          // Only add if not already found (dedupe with full file walk)
          if (!symbols.some(s => s.name === methodName && s.file === relativePath && s.line_start === node.loc.start.line)) {
            symbols.push({
              id: methodName,
              name: methodName,
              kind: 'function',
              file: relativePath,
              line_start: node.loc.start.line,
              line_end: func.loc.end.line,
              signature: `${methodName}(${(func.params || []).map(p => extractParamName(p)).join(', ')})`,
              params: (func.params || []).map(p => extractParamName(p)),
              async: func.async || false,
              static: node.static || false,
              enclosing: getEnclosingName(parent, grandparent),
            });
          }
        }
        // Getters and setters
        if ((node.kind === 'get' || node.kind === 'set') && node.key?.type === 'Identifier') {
          const prefix = node.kind === 'get' ? 'get ' : 'set ';
          if (!symbols.some(s => s.name === prefix + node.key.name)) {
            symbols.push({
              id: prefix + node.key.name,
              name: prefix + node.key.name,
              kind: node.kind === 'get' ? 'getter' : 'setter',
              file: relativePath,
              line_start: node.loc.start.line,
              line_end: node.value?.loc?.end?.line || node.loc.end.line,
              signature: `${prefix}${node.key.name}()`,
              params: [],
              enclosing: getEnclosingName(parent, grandparent),
            });
          }
        }
        break;
      }

      // === Exports ===
      case 'ExportNamedDeclaration': {
        if (node.declaration?.id?.name) {
          const existing = symbols.find(s => s.name === node.declaration.id.name && s.file === relativePath);
          if (existing) existing.exported = true;
        }
        break;
      }
      case 'ExportDefaultDeclaration': {
        if (node.declaration?.id?.name) {
          const existing = symbols.find(s => s.name === node.declaration.id.name && s.file === relativePath);
          if (existing) existing.exported = true;
        }
        // Also handle `export default { ... }`
        if (node.declaration?.type === 'ObjectExpression') {
          symbols.push({
            id: 'default',
            name: 'default',
            kind: 'export',
            file: relativePath,
            line_start: node.loc.start.line,
            line_end: node.loc.end.line,
            exported: true,
            signature: 'export default { ... }',
          });
        }
        break;
      }

      // === Import statements ===
      case 'ImportDeclaration': {
        if (node.source?.value) {
          const imported = [];
          for (const spec of node.specifiers || []) {
            if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
              imported.push(spec.local?.name);
            } else if (spec.type === 'ImportSpecifier') {
              imported.push(spec.imported?.name || spec.local?.name);
            }
          }
          imports.push({
            source: node.source.value,
            specifiers: imported,
            line: node.loc.start.line,
          });
        }
        break;
      }

      // === Require calls ===
      case 'CallExpression': {
        if (node.callee?.name === 'require' && node.arguments[0]?.type === 'Literal') {
          imports.push({
            source: node.arguments[0].value,
            specifiers: [],
            line: node.loc.start.line,
            type: 'require',
          });
        }
        break;
      }

      // === Assignment exports (module.exports = ...) ===
      case 'AssignmentExpression': {
        if (node.left?.type === 'MemberExpression' && 
            node.left.object?.name === 'module' && 
            node.left.property?.name === 'exports') {
          if (node.right?.type === 'ObjectExpression') {
            // Extract named properties from module.exports = { ... }
            for (const prop of node.right.properties || []) {
              if (prop.key?.type === 'Identifier' && prop.shorthand) {
                const existing = symbols.find(s => s.name === prop.key.name && s.file === relativePath);
                if (existing) existing.exported = true;
              }
            }
            // Also mark these as file-level exports
            exports.push({ type: 'module.exports', names: '*' });
          } else if (node.right?.type === 'Identifier') {
            const existing = symbols.find(s => s.name === node.right.name && s.file === relativePath);
            if (existing) existing.exported = true;
          }
        }
        break;
      }
    }
  });

  // Attach imports to first symbol or as standalone
  if (imports.length > 0 && symbols.length > 0) {
    symbols[0].imports = imports;
  }

  return { symbols, imports, exports };
}

/**
 * Walk AST tree with parent/grandparent context
 */
function walkNode(node, parent, callback, grandparent = null) {
  if (!node || typeof node !== 'object') return;
  
  if (Array.isArray(node)) {
    for (const child of node) {
      walkNode(child, parent, callback, grandparent);
    }
    return;
  }

  if (node.type) {
    callback(node, parent, grandparent);
  }

  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const child = node[key];
    if (child && typeof child === 'object') {
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c === 'object') walkNode(c, node, callback, parent);
        }
      } else if (child.type) {
        walkNode(child, node, callback, parent);
      }
    }
  }
}

function extractSignature(content, node) {
  const start = node.start;
  const end = node.body ? node.body.start : Math.min(start + 80, content.length);
  return content.substring(start, end).split('\n')[0].trim().slice(0, 120);
}

function extractParamName(param) {
  if (!param) return '';
  if (param.type === 'Identifier') return param.name;
  if (param.type === 'AssignmentPattern') return extractParamName(param.left);
  if (param.type === 'RestElement') return `...${param.argument?.name || ''}`;
  if (param.type === 'ObjectPattern') return '{ ... }';
  if (param.type === 'ArrayPattern') return '[ ... ]';
  return '';
}

function isExported(node, parent) {
  if (!parent) return false;
  if (parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportDefaultDeclaration') return true;
  return false;
}

function getEnclosingName(parent, grandparent) {
  if (!parent) return null;
  if (parent.type === 'ClassDeclaration' && parent.id?.name) return parent.id.name;
  if (parent.type === 'ClassExpression' && parent.id?.name) return parent.id.name;
  if (parent.type === 'VariableDeclarator' && parent.id?.name) {
    // Check if the grandparent indicates this is an object
    if (grandparent?.type === 'VariableDeclaration') {
      return parent.id.name;
    }
  }
  // For Property nodes, the parent is the object
  if (parent.type === 'ObjectExpression') {
    return '(object literal)';
  }
  return null;
}

function extractMemberExpr(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') {
    const obj = extractMemberExpr(node.object);
    const prop = node.property?.name || '';
    return obj ? `${obj}.${prop}` : prop;
  }
  return '';
}
