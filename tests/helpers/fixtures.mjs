/**
 * Fixture-gated tests.
 *
 * `bench/php-app` and `bench/vue-app` are customer-code copies and are deliberately not
 * vendored, so any test that indexes them cannot run in a fresh clone — and CI already
 * runs a fixture-free subset for the same reason. Those tests used to FAIL locally,
 * which made a red/green signal meaningless: 49 permanent failures hid real regressions.
 * They now SKIP with a reason; when the fixtures are present they run exactly as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const has = (rel) => fs.existsSync(path.resolve(rel));
export const FIXTURES = { php: has('bench/php-app'), vue: has('bench/vue-app') };
export const NEED = FIXTURES.php && FIXTURES.vue;
export const WHY = 'needs bench/php-app + bench/vue-app (customer-code copies, not vendored) — run node bench/gen_ground_truth.mjs where the fixtures exist';

/** Drop-in replacement for node:test's `test`, gated on the fixture corpus. */
export function testWithFixtures(name, optsOrFn, maybeFn) {
  const opts = typeof optsOrFn === 'function' ? {} : optsOrFn;
  const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
  return test(name, NEED ? opts : { ...opts, skip: WHY }, fn);
}
