/**
 * Directory entry shim.
 *
 * Node's test runner (v22+) treats positional arguments as glob patterns, so a
 * bare directory (`node --test tests/engines/`) is not expanded and instead
 * fails to load. Resolving the directory to this entry file makes the literal
 * acceptance command work; each imported module registers its own tests.
 *
 * Canonical glob form (per-file isolation) still works:
 *   node --test "tests/engines/**\/*.test.mjs"
 */
import './fusion.test.mjs';
import './codegraph.test.mjs';
import './gitnexus.test.mjs';
import './mcp-tools.test.mjs';
import './smoke.test.mjs';
