/**
 * Tests for src/resolver/blade.js — Blade template call extraction.
 *
 * Run: node --test tests/resolver/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractBladeCalls } from '../../src/resolver/blade.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const memberBlade = path.join(repo, 'bench', 'php-app', 'views', 'analyses', 'member.blade.php');

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('member.blade.php → the 3 showSelectOptions calls have the right receivers', () => {
  const calls = extractBladeCalls(memberBlade);

  // Requirement: the showSelectOptions subset is exactly 3, with these vars/lines.
  const sel = calls.filter(c => c.callee === 'showSelectOptions');
  assert.equal(sel.length, 3, 'three showSelectOptions calls');
  assert.deepEqual(sel.map(c => c.var), ['groupPresenter', 'hospitalPresenter', 'departmentPresenter']);
  assert.deepEqual(sel.map(c => c.line), [25, 36, 46]);

  // Completeness + precision: the file's ONLY $var->method( calls are these 8
  // (the 3 above plus five `$data->sum(...)`, two of them on line 105).
  assert.deepEqual(calls.map(c => `${c.line}:${c.var}.${c.callee}`), [
    '25:groupPresenter.showSelectOptions',
    '36:hospitalPresenter.showSelectOptions',
    '46:departmentPresenter.showSelectOptions',
    '102:data.sum',
    '103:data.sum',
    '104:data.sum',
    '105:data.sum',
    '105:data.sum',
  ]);
});

test('precision: blade comments, DB:: static calls and bare text are NOT matched', () => {
  const f = path.join(dir, 'precision.blade.php');
  fs.writeFileSync(f, [
    '{{-- {{ $hidden->ghost(1) }} --}}',
    '{!! $p->real(1) !!}',
    '{{ $q->also(2) }}',
    '@if($r->cond(3))',
    '@foreach($xs as $x)',
    '  @if($s?->maybe(4))',
    '@endforeach',
    "DB::table('departments')->get();",
    "<?php DB::table('x'); $plain = 1; ?>",
    '{{-- multi-line comment',
    '   $deep->commented(9)',
    '--}}',
    '{{ $chain->first->second(5) }}',
  ].join('\n'));

  const got = extractBladeCalls(f).map(c => `${c.var}.${c.callee}`);
  // $chain->first->second( must NOT be reported (receiver is not a bare $var)
  assert.deepEqual(got, ['p.real', 'q.also', 'r.cond', 's.maybe']);
});

test('nullsafe ->? and directive forms are captured', () => {
  const f = path.join(dir, 'nullsafe.blade.php');
  fs.writeFileSync(f, [
    '@foreach ($rows as $row)',
    '  {!! $presenter?->showSelectOptions($groups, $id) !!}',
    '@endforeach',
    '@if ($user->canAccess($id))',
  ].join('\n'));
  const calls = extractBladeCalls(f);
  assert.deepEqual(calls.map(c => `${c.var}.${c.callee}`), ['presenter.showSelectOptions', 'user.canAccess']);
  assert.deepEqual(calls.map(c => c.line), [2, 4]);
});
