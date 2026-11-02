/**
 * laravel-routes.test.mjs — how a route's URI is assembled.
 *
 * The regression this file exists for: a prefix applied by a SERVICE PROVIDER is not in
 * the route file at all, and bootstrap files (`routes/kefuapi.php`) merely `require` the
 * real one. Before 2026-11-02 those 92 routes were read without their prefix, so
 * `kefuapi/login` appeared as plain `login` and the customer frontend's `POST login`
 * was paired to the kefu handler — which manufactured a "missing field" finding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractLaravelRoutes } from '../src/parsers/laravelRoutes.js';

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-routes-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const uris = (dir) => extractLaravelRoutes(dir, []).routes.map((r) => `${r.method} ${r.uri}`).sort();

test('a provider prefix variable + require chain is inherited (the kefuapi case)', (t) => {
  const dir = repo({
    'app/Providers/LegacyApiRouteServiceProvider.php': [
      '<?php',
      'final class LegacyApiRouteServiceProvider {',
      '  public function boot(): void {',
      '    foreach ([',
      "      'kefuapi' => base_path('routes/kefuapi.php'),",
      "      'adminapi' => base_path('routes/adminapi.php'),",
      '    ] as $prefix => $routeFile) {',
      "      Route::middleware('api')->prefix($prefix)->group($routeFile);",
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'),
    'routes/kefuapi.php': "<?php\nrequire __DIR__.'/api/kefu.php';\n",
    'routes/api/kefu.php': [
      '<?php',
      "Route::post('login', [KefuLoginController::class, 'login']);",
      "Route::get('order/list', [KefuOrderController::class, 'lst']);",
      '',
    ].join('\n'),
    'routes/adminapi.php': "<?php\nRoute::post('login', [LoginController::class, 'login']);\n",
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const got = uris(dir);
  assert.deepEqual(got, ['GET kefuapi/order/list', 'POST adminapi/login', 'POST kefuapi/login'],
    `every mounted file keeps its prefix: ${got.join(' | ')}`);
});

test('a literal prefix beside group() is applied', (t) => {
  const dir = repo({
    'app/Providers/RouteServiceProvider.php': [
      '<?php',
      "Route::prefix('api')->group(base_path('routes/api.php'));",
      '',
    ].join('\n'),
    'routes/api.php': "<?php\nRoute::get('users', [UserController::class, 'index']);\n",
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  assert.deepEqual(uris(dir), ['GET api/users']);
});

test('an array-option prefix `Route::group([...], file)` is applied', (t) => {
  const dir = repo({
    'app/Providers/RouteServiceProvider.php': [
      '<?php',
      "Route::group(['prefix' => 'admin'], base_path('routes/admin.php'));",
      '',
    ].join('\n'),
    'routes/admin.php': "<?php\nRoute::get('users', [AdminUserController::class, 'index']);\n",
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  assert.deepEqual(uris(dir), ['GET admin/users']);
});

test('without a provider mount the uri is unchanged (no invented prefix)', (t) => {
  const dir = repo({
    'routes/web.php': "<?php\nRoute::get('health', [HealthController::class, 'show']);\n",
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  assert.deepEqual(uris(dir), ['GET health']);
});

test('a require chain does not double-apply a prefix', (t) => {
  // the bootstrap is mounted once; the included file must inherit exactly once
  const dir = repo({
    'app/Providers/P.php': "<?php\nRoute::prefix('kefuapi')->group(base_path('routes/boot.php'));\n",
    'routes/boot.php': "<?php\nrequire __DIR__.'/api/a.php';\nrequire __DIR__.'/api/b.php';\n",
    'routes/api/a.php': "<?php\nRoute::get('one', [A::class, 'one']);\n",
    'routes/api/b.php': "<?php\nRoute::get('two', [B::class, 'two']);\n",
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  assert.deepEqual(uris(dir), ['GET kefuapi/one', 'GET kefuapi/two']);
});
