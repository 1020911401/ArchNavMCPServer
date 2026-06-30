"""Python AST Parser — v2: correctly handles class methods and nested defs"""
import ast, json, sys

def extract(node, parent_name=None):
    result = []
    
    if isinstance(node, ast.Module):
        for child in ast.iter_child_nodes(node):
            result.extend(extract(child))
    
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        params = [a.arg for a in node.args.args]
        if node.args.vararg: params.append(f'*{node.args.vararg.arg}')
        if node.args.kwonlyargs: params.extend(a.arg for a in node.args.kwonlyargs)
        if node.args.kwarg: params.append(f'**{node.args.kwarg.arg}')
        result.append({
            'id': node.name, 'name': node.name, 'kind': 'function',
            'line_start': node.lineno, 'line_end': node.end_lineno or node.lineno,
            'signature': f"def {node.name}({', '.join(params)})",
            'params': params,
            'async': isinstance(node, ast.AsyncFunctionDef),
            'enclosing': parent_name,
        })
    
    elif isinstance(node, ast.ClassDef):
        bases = [b.id for b in node.bases if isinstance(b, ast.Name)]
        result.append({
            'id': node.name, 'name': node.name, 'kind': 'class',
            'line_start': node.lineno, 'line_end': node.end_lineno or node.lineno,
            'signature': f"class {node.name}" + (f"({', '.join(bases)})" if bases else ''),
            'superClass': bases[0] if bases else None,
        })
        for child in ast.iter_child_nodes(node):
            result.extend(extract(child, node.name))
    
    elif isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Name):
                result.append({
                    'id': t.id, 'name': t.id, 'kind': 'variable',
                    'line_start': node.lineno, 'line_end': node.end_lineno or node.lineno,
                    'signature': f"{t.id} = ...",
                    'enclosing': parent_name,
                })
    
    elif isinstance(node, ast.AnnAssign):
        if isinstance(node.target, ast.Name):
            ann = ast.unparse(node.annotation) if node.annotation else ''
            result.append({
                'id': node.target.id, 'name': node.target.id, 'kind': 'variable',
                'line_start': node.lineno, 'line_end': node.end_lineno or node.lineno,
                'signature': f"{node.target.id}: {ann}",
                'enclosing': parent_name,
            })
    
    # AsyncFor and other async constructs
    elif isinstance(node, ast.AsyncFor):
        if isinstance(node.target, ast.Name):
            result.append({
                'id': node.target.id, 'name': node.target.id, 'kind': 'variable',
                'line_start': node.lineno, 'line_end': node.end_lineno or node.lineno,
                'signature': f"async for {node.target.id} in ...",
            })
    
    return result

def extract_imports(node):
    imports = []
    for child in ast.walk(node):
        if isinstance(child, ast.Import):
            for alias in child.names:
                imports.append({
                    'source': alias.name,
                    'specifiers': [n.name for n in child.names],
                    'line': child.lineno
                })
        elif isinstance(child, ast.ImportFrom):
            imports.append({
                'source': child.module or '',
                'specifiers': [a.name for a in child.names],
                'line': child.lineno
            })
    return imports

filepath = sys.argv[1]
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

try:
    tree = ast.parse(content, filename=filepath)
    symbols = extract(tree)
    # Deduplicate
    seen = set()
    deduped = []
    for s in symbols:
        key = (s['name'], s['line_start'])
        if key not in seen:
            seen.add(key)
            deduped.append(s)
    result = {'symbols': deduped, 'imports': extract_imports(tree)}
    print(json.dumps(result))
except SyntaxError as e:
    print(json.dumps({'symbols': [], 'imports': [], 'error': str(e)}))
