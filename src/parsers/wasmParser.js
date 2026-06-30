/**
 * WASM Tree-Sitter Parser — Multi-language parser using web-tree-sitter + WASM grammars
 * 
 * Languages: Go, Rust, Java (via tree-sitter-wasms prebuilt WASM files)
 * Zero native compilation — 100% WASM in Node.js
 */
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

// Use @vscode/tree-sitter-wasm for both runtime and grammars (guaranteed compatible)
const VSCODE_WASM_DIR = path.resolve(__dirname, '../../node_modules/@vscode/tree-sitter-wasm/wasm');

// WASM grammar directory
const WASM_DIR = path.resolve(__dirname, '../../node_modules/tree-sitter-wasms/out');

// Language-specific tree-sitter query patterns for symbol extraction
const QUERIES = {
  go: {
    // Function declarations
    function: `(function_declaration
      name: (identifier) @name
      parameters: (parameter_list) @params) @func`,
    // Method declarations  
    method: `(method_declaration
      name: (field_identifier) @name
      parameters: (parameter_list) @params) @method`,
    // Interface types
    interface: `(interface_type
      name: (type_identifier) @name) @iface`,
    // Struct types
    struct: `(type_declaration
      (type_spec
        name: (type_identifier) @name
        type: (struct_type) @struct)) @struct_decl`,
  },
  rust: {
    // Function declarations
    function: `(function_item
      name: (identifier) @name
      params: (parameters) @params) @func`,
    // Struct declarations
    struct: `(struct_item
      name: (type_identifier) @name) @struct_item`,
    // Enum declarations
    enum: `(enum_item
      name: (type_identifier) @name) @enum_item`,
    // Trait declarations  
    trait: `(trait_item
      name: (type_identifier) @name) @trait_item`,
    // Impl blocks
    impl: `(impl_item
      trait: (type_identifier)? @trait
      type: (type_identifier) @type) @impl_item`,
    // Macro invocations with specific names
    macro: `(macro_invocation
      macro: (identifier) @macro_name
      (token_tree) @body) @macro`,
  },
  java: {
    // Class declarations
    class: `(class_declaration
      name: (identifier) @name
      superclass: (superclass (type_identifier) @super)?) @class_decl`,
    // Interface declarations
    interface: `(interface_declaration
      name: (identifier) @name) @iface_decl`,
    // Enum declarations
    enum: `(enum_declaration
      name: (identifier) @name) @enum_decl`,
    // Method declarations (inside classes)
    method: `(method_declaration
      name: (identifier) @name
      parameters: (formal_parameters) @params
      type: (type_identifier)? @return_type) @method_decl`,
    // Constructor declarations
    constructor: `(constructor_declaration
      name: (identifier) @name
      parameters: (formal_parameters) @params) @ctor_decl`,
    // Annotation type declarations
    annotation: `(annotation_type_declaration
      name: (identifier) @name) @ann_decl`,
  },
  php: {
    // Function declarations
    function: `(function_definition
      name: (name) @name
      parameters: (formal_parameters)? @params) @func_def`,
    // Method declarations inside classes
    method: `(method_declaration
      name: (name) @name
      parameters: (formal_parameters)? @params) @method_def`,
    // Class declarations
    class: `(class_declaration
      name: (_) @name) @class_def`,
    // Interface declarations
    interface: `(interface_declaration
      name: (name) @name) @iface_def`,
    // Trait declarations
    trait: `(trait_declaration
      name: (name) @name) @trait_def`,
    // Enum declarations (PHP 8.1+)
    enum: `(enum_declaration
      name: (name) @name) @enum_def`,
  },
  // ═══════════════════════════════
  //  C / C++
  // ═══════════════════════════════
  cpp: {
    function: `(function_definition
      declarator: (function_declarator
        declarator: (identifier) @name
        parameters: (parameter_list)? @params)) @func_def`,
    class: `(class_specifier
      name: (type_identifier) @name) @class_spec`,
    struct: `(struct_specifier
      name: (type_identifier) @name) @struct_spec`,
    enum: `(enum_specifier
      name: (type_identifier) @name) @enum_spec`,
  },
  // ═══════════════════════════════
  //  C#
  // ═══════════════════════════════
  'c-sharp': {
    class: `(class_declaration
      name: (identifier) @name) @class_decl`,
    interface: `(interface_declaration
      name: (identifier) @name) @iface_decl`,
    struct: `(struct_declaration
      name: (identifier) @name) @struct_decl`,
    enum: `(enum_declaration
      name: (identifier) @name) @enum_decl`,
    method: `(method_declaration
      name: (identifier) @name
      parameters: (parameter_list)? @params) @method_decl`,
    constructor: `(constructor_declaration
      name: (identifier) @name
      parameters: (parameter_list)? @params) @ctor_decl`,
  },
  // ═══════════════════════════════
  //  Ruby
  // ═══════════════════════════════
  ruby: {
    method: `(method
      name: (identifier) @name
      parameters: (method_parameters)? @params) @method_def`,
    class: `(class
      name: (constant) @name
      superclass: (superclass (constant) @super)?) @class_def`,
    module: `(module
      name: (constant) @name) @module_def`,
  },
  // ═══════════════════════════════
  //  Bash
  // ═══════════════════════════════
  bash: {
    func_def: `(function_definition
      name: (word) @name
      body: (compound_statement) @body) @func_def`,
  },
  // ═══════════════════════════════
  //  PowerShell
  // ═══════════════════════════════
  powershell: {
    function: `(function_definition
      name: (_) @name
      body: (script_block) @body) @func_def`,
    class: `(class_definition
      name: (identifier) @name) @class_def`,
    enum: `(enum_definition
      name: (identifier) @name) @enum_def`,
  },
};

/**
 * Parse a file using WASM tree-sitter
 */
export async function parseWasmFile(filePath, baseDir, fileContent) {
  const ext = path.extname(filePath).toLowerCase();
  const langMap = {
    '.go': 'go', '.go.txt': 'go',
    '.rs': 'rust',
    '.java': 'java', '.jav': 'java',
    '.php': 'php', '.php5': 'php', '.phtml': 'php',
    '.c': 'cpp', '.h': 'cpp',         // C (uses cpp grammar from @vscode)
    '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
    '.cs': 'c-sharp',
    '.rb': 'ruby', '.ruby': 'ruby',
    '.sh': 'bash', '.bash': 'bash',
    '.ps1': 'powershell', '.psm1': 'powershell', '.psd1': 'powershell',
  };
  
  const langName = langMap[ext];
  if (!langName) return { symbols: [], error: `Unsupported language: ${ext}` };

  try {
    // Use @vscode/tree-sitter-wasm runtime (guaranteed compatible with its grammars)
    const tsWasm = _require('@vscode/tree-sitter-wasm/wasm/tree-sitter.js');
    const Parser = tsWasm.Parser;
    const Language = tsWasm.Language;
    
    // Initialize WASM runtime with the bundled tree-sitter.wasm
    const runtimeWasm = await readFile(path.join(VSCODE_WASM_DIR, 'tree-sitter.wasm'));
    await Parser.init(runtimeWasm);

    // Load VS Code's compatible WASM grammar
    const wasmPath = path.join(VSCODE_WASM_DIR, `tree-sitter-${langName}.wasm`);
    const wasmBuffer = await readFile(wasmPath);
    const lang = await Language.load(wasmBuffer);
    
    // Create parser and parse
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(fileContent);
    const rootNode = tree.rootNode;
    
    // Extract symbols using language-specific queries
    const symbols = [];
    const queries = QUERIES[langName];
    
    for (const [kind, pattern] of Object.entries(queries)) {
      try {
        const Query = tsWasm.Query;
        const query = new Query(lang, pattern);
        const matches = query.matches(rootNode);
        
        for (const match of matches) {
          const captures = {};
          for (const capture of match.captures) {
            const name = capture.name;
            if (!captures[name]) captures[name] = [];
            captures[name].push(capture.node);
          }

          // Determine the symbol name from captures
          let name = null;
          if (captures.name && captures.name.length > 0) {
            name = fileContent.substring(captures.name[0].startIndex, captures.name[0].endIndex);
          } else if (captures.macro_name && captures.macro_name.length > 0) {
            name = fileContent.substring(captures.macro_name[0].startIndex, captures.macro_name[0].endIndex);
          }

          if (!name) continue;

          // Calculate line range from the main node
          const mainNode = captures[Object.keys(captures)[0]]?.[0];
          if (!mainNode) continue;
          
          // Skip duplicates
          if (symbols.some(s => s.name === name && s.line_start === mainNode.startPosition.row + 1)) continue;

          const params = captures.params?.[0]
            ? extractParamsFromText(fileContent, captures.params[0])
            : [];

          const sym = {
            id: name,
            name,
            kind: mapKind(kind, langName),
            file: path.relative(baseDir, filePath).replace(/\\/g, '/'),
            line_start: mainNode.startPosition.row + 1,
            line_end: mainNode.endPosition.row + 1,
            signature: `${name}(${params.join(', ')})`,
            params,
          };

          // Add language-specific metadata
          if (captures.super && captures.super.length > 0) {
            sym.superClass = fileContent.substring(captures.super[0].startIndex, captures.super[0].endIndex);
          }
          if (captures.return_type && captures.return_type.length > 0) {
            sym.returnType = fileContent.substring(captures.return_type[0].startIndex, captures.return_type[0].endIndex);
          }
          if (kind === 'impl') {
            const implType = captures.type?.[0]
              ? fileContent.substring(captures.type[0].startIndex, captures.type[0].endIndex) : '';
            sym.kind = 'impl';
            sym.signature = `impl ${implType}`;
          }

          symbols.push(sym);
        }
      } catch (e) {
        // Skip queries that fail (e.g., grammar version mismatch)
      }
    }

    return { symbols };
  } catch (e) {
    return { symbols: [], error: e.message };
  }
}

function mapKind(queryKind, lang) {
  const kindMap = {
    go: { function: 'function', method: 'function', interface: 'interface', struct: 'class' },
    rust: { function: 'function', struct: 'class', enum: 'enum', trait: 'interface', impl: 'impl', macro: 'macro' },
    java: { class: 'class', interface: 'interface', enum: 'enum', method: 'function', constructor: 'constructor', annotation: 'annotation' },
    php: { function: 'function', method: 'function', class: 'class', interface: 'interface', trait: 'trait', enum: 'enum' },
    cpp: { function: 'function', class: 'class', struct: 'struct', enum: 'enum' },
    'c-sharp': { class: 'class', interface: 'interface', struct: 'struct', enum: 'enum', method: 'function', constructor: 'constructor' },
    ruby: { method: 'function', class: 'class', module: 'module' },
    bash: { func_def: 'function' },
    powershell: { function: 'function', class: 'class', enum: 'enum' },
  };
  return kindMap[lang]?.[queryKind] || 'symbol';
}

function extractParamsFromText(content, node) {
  const text = content.substring(node.startIndex, node.endIndex).trim();
  // Simple extraction: find identifiers between parens
  const params = [];
  const inner = text.replace(/^\(|\)$/g, '');
  for (const part of inner.split(',')) {
    const trimmed = part.trim();
    // Get the last word (usually the param name in typed languages)
    const words = trimmed.split(/\s+/);
    const name = words[words.length - 1]?.replace(/[\[\]&*]/g, '') || '';
    if (name && name !== '...' && !name.startsWith('.')) params.push(name);
  }
  return params;
}

/**
 * Read WASM file as ArrayBuffer
 */
async function readFileBuffer(filePath) {
  return await readFile(filePath);
}
