/**
 * TypeScript Parser — TS/TSX AST parsing via @typescript-eslint/parser
 * Zero native deps (pure JS, TypeScript compiler is self-hosting in JS)
 */
import { parse } from '@typescript-eslint/parser';
import fs from 'fs';
import path from 'path';

/**
 * Parse a TypeScript file and extract symbols
 */
export function parseTypeScriptFile(filePath, baseDir) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const relativePath = path.relative(baseDir, filePath);
  const symbols = [];
  const imports = [];

  let ast;
  try {
    ast = parse(content, {
      ecmaVersion: 2022,
      sourceType: 'module',
      loc: true,
      range: true,
      jsx: filePath.endsWith('.tsx'),
    });
  } catch (e) {
    // Try loose parse for problematic files
    try {
      ast = parse(content, {
        ecmaVersion: 2022,
        sourceType: 'module',
        loc: true,
        range: true,
        jsx: filePath.endsWith('.tsx'),
        errorRecovery: true,
      });
    } catch {
      return { symbols: [], imports: [] };
    }
  }

  walkTS(ast, null, (node, parent, grandparent) => {
    switch (node.type) {
      // Function declarations
      case 'FunctionDeclaration': {
        if (node.id?.name) {
          symbols.push({
            id: node.id.name,
            name: node.id.name,
            kind: 'function',
            file: relativePath,
            line_start: node.loc.start.line,
            line_end: node.loc.end.line,
            signature: extractTSSig(node),
            params: (node.params || []).map(p => extractTSParam(p)),
            exported: isTSExported(node, parent),
            async: !!node.async,
          });
        }
        break;
      }

      // Arrow/function expressions assigned to const
      case 'VariableDeclarator': {
        if (node.id?.type === 'Identifier' &&
            (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')) {
          const typeAnn = node.id.typeAnnotation ? extractTSType(node.id.typeAnnotation) : '';
          symbols.push({
            id: node.id.name,
            name: node.id.name,
            kind: 'function',
            file: relativePath,
            line_start: node.loc.start.line,
            line_end: node.loc.end.line,
            signature: `${node.id.name}${typeAnn} = (${(node.init.params || []).map(p => extractTSParam(p)).join(', ')}) =>`,
            params: (node.init.params || []).map(p => extractTSParam(p)),
            exported: isTSExported(node, parent),
            async: !!node.init.async,
          });
        }
        break;
      }

      // Class declarations (with generics, implements, etc.)
      case 'ClassDeclaration': {
        if (node.id?.name) {
          const superClass = node.superClass
            ? (node.superClass.type === 'Identifier' ? node.superClass.name : 'expr')
            : null;
          const implements_ = (node.implements || []).map(i =>
            i.type === 'Identifier' ? i.name : 'expr'
          );
          symbols.push({
            id: node.id.name,
            name: node.id.name,
            kind: 'class',
            file: relativePath,
            line_start: node.loc.start.line,
            line_end: node.loc.end.line,
            signature: `class ${node.id.name}${superClass ? ` extends ${superClass}` : ''}${implements_.length ? ` implements ${implements_.join(', ')}` : ''}`,
            superClass,
            implements: implements_,
            exported: isTSExported(node, parent),
          });
        }
        break;
      }

      // Interface declarations
      case 'TSInterfaceDeclaration': {
        if (node.id?.name) {
          const extends_ = (node.extends || []).map(e =>
            e.type === 'Identifier' ? e.name : 'expr'
          );
          symbols.push({
            id: node.id.name,
            name: node.id.name,
            kind: 'interface',
            file: relativePath,
            line_start: node.loc.start.line,
            line_end: node.loc.end.line,
            signature: `interface ${node.id.name}${extends_.length ? ` extends ${extends_.join(', ')}` : ''}`,
            extends: extends_,
            exported: isTSExported(node, parent),
          });
        }
        break;
      }

      // Type aliases
      case 'TSTypeAliasDeclaration': {
        if (node.id?.name) {
          symbols.push({
            id: node.id.name,
            name: node.id.name,
            kind: 'type',
            file: relativePath,
            line_start: node.loc.start.line,
            line_end: node.loc.end.line,
            signature: `type ${node.id.name}`,
            exported: isTSExported(node, parent),
          });
        }
        break;
      }

      // Enum declarations
      case 'TSEnumDeclaration': {
        if (node.id?.name) {
          symbols.push({
            id: node.id.name,
            name: node.id.name,
            kind: 'enum',
            file: relativePath,
            line_start: node.loc.start.line,
            line_end: node.loc.end.line,
            signature: `enum ${node.id.name}`,
            exported: isTSExported(node, parent),
          });
        }
        break;
      }

      // Object/class methods
      case 'MethodDefinition':
      case 'Property': {
        const isMethod = node.type === 'MethodDefinition' ||
          (node.type === 'Property' && node.method);
        if (isMethod && node.key?.type === 'Identifier' && node.value?.type === 'FunctionExpression') {
          if (!symbols.some(s => s.name === node.key.name && s.file === relativePath && s.line_start === node.loc.start.line)) {
            symbols.push({
              id: node.key.name,
              name: node.key.name,
              kind: 'function',
              file: relativePath,
              line_start: node.loc.start.line,
              line_end: node.value.loc.end.line,
              signature: `${node.key.name}(${(node.value.params || []).map(p => extractTSParam(p)).join(', ')})`,
              params: (node.value.params || []).map(p => extractTSParam(p)),
              async: !!node.value.async,
              static: node.static || false,
              access: node.accessibility || 'public',
              enclosing: getTSEnclosing(parent, grandparent),
            });
          }
        }
        // Getters/setters
        if ((node.kind === 'get' || node.kind === 'set') && node.key?.type === 'Identifier') {
          const prefix = node.kind === 'get' ? 'get ' : 'set ';
          symbols.push({
            id: prefix + node.key.name,
            name: prefix + node.key.name,
            kind: node.kind === 'get' ? 'getter' : 'setter',
            file: relativePath,
            line_start: node.loc.start.line,
            line_end: node.value?.loc?.end?.line || node.loc.end.line,
            enclosing: getTSEnclosing(parent, grandparent),
          });
        }
        break;
      }

      // Imports
      case 'ImportDeclaration': {
        if (node.source?.value) {
          imports.push({
            source: node.source.value,
            specifiers: (node.specifiers || []).map(s => s.local?.name || s.imported?.name).filter(Boolean),
            line: node.loc.start.line,
          });
        }
        break;
      }

      // Export assignments
      case 'ExportAssignment': {
        // `export default X` or `export = X`
        if (node.expression?.type === 'Identifier') {
          const existing = symbols.find(s => s.name === node.expression.name && s.file === relativePath);
          if (existing) existing.exported = true;
        }
        break;
      }
    }
  });

  // Attach imports to first symbol
  if (imports.length > 0 && symbols.length > 0) {
    symbols[0].imports = imports;
  }

  return { symbols, imports };
}

function walkTS(node, parent, callback, grandparent = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkTS(child, parent, callback, grandparent);
    return;
  }
  if (node.type) callback(node, parent, grandparent);
  for (const key of Object.keys(node)) {
    if (['parent', 'start', 'end', 'loc', 'range'].includes(key)) continue;
    const child = node[key];
    if (child && typeof child === 'object') {
      if (Array.isArray(child)) for (const c of child) { if (c && typeof c === 'object') walkTS(c, node, callback, parent); }
      else if (child.type) walkTS(child, node, callback, parent);
    }
  }
}

function extractTSSig(node) {
  const params = (node.params || []).map(p => extractTSParam(p)).join(', ');
  const retType = node.returnType ? extractTSType(node.returnType) : '';
  return `${node.id?.name || ''}(${params})${retType}`;
}

function extractTSParam(param) {
  if (!param) return '';
  if (param.type === 'Identifier') {
    const ann = param.typeAnnotation ? extractTSType(param.typeAnnotation) : '';
    return `${param.name}${ann}`;
  }
  if (param.type === 'AssignmentPattern') return `${extractTSParam(param.left)} = ...`;
  if (param.type === 'RestElement') return `...${param.argument?.name || ''}`;
  if (param.type === 'ObjectPattern') return '{ ... }';
  if (param.type === 'ArrayPattern') return '[ ... ]';
  return '';
}

function extractTSType(ann) {
  if (!ann || !ann.typeAnnotation) return '';
  const t = ann.typeAnnotation;
  if (t?.type === 'TSStringKeyword') return ': string';
  if (t?.type === 'TSNumberKeyword') return ': number';
  if (t?.type === 'TSBooleanKeyword') return ': boolean';
  if (t?.type === 'TSVoidKeyword') return ': void';
  if (t?.type === 'TSAnyKeyword') return ': any';
  if (t?.type === 'TSTypeReference' && t.typeName?.type === 'Identifier') return `: ${t.typeName.name}`;
  if (t?.type === 'TSArrayType') return ': []';
  if (t?.type === 'TSUnionType') return ': union';
  if (t?.type === 'TSTypeLiteral') return ': { ... }';
  return '';
}

function isTSExported(node, parent) {
  return parent?.type === 'ExportNamedDeclaration' ||
    parent?.type === 'ExportDefaultDeclaration' ||
    parent?.type === 'ExportAssignment';
}

function getTSEnclosing(parent, grandparent) {
  if (!parent) return null;
  if (parent.type === 'ClassDeclaration' && parent.id?.name) return parent.id.name;
  if (parent.type === 'ClassExpression' && parent.id?.name) return parent.id.name;
  if (parent.type === 'TSInterfaceDeclaration' && parent.id?.name) return parent.id.name;
  if (parent.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name;
  return null;
}
