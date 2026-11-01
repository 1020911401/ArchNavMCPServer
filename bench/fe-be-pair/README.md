# bench/fe-be-pair — tracked ground truth for the front/back boundary rules

The other two fixtures (`php-app`, `vue-app`) are customer-code copies and stay out of
git; measured against them the pairing rate is **3.6%**, i.e. they are *not* a
front/back pair — so `fe-be-path-not-found` / `fe-be-method-mismatch` /
`fe-be-route-unused` were only ever unit-tested, never validated end to end.

This pair is invented, tiny and tracked so `npm test` can validate the boundary rules
against known numbers on every run (including CI, where the other fixtures are absent).

| expectation | count | how |
| --- | --- | --- |
| `fe-be-path-not-found` | 2 | `/api/ghost-a`, `/api/ghost-b` |
| `fe-be-method-mismatch` | 1 | `POST /api/wrong-method` vs `GET` route |
| `fe-be-route-unused` | 3 | `health`, `legacy`, and `GET wrong-method` (never correctly called) |
| `fe-be-pairing-suspect` | 0 | 6 of 9 unique paths match = 67% (floor is 20%) |
| `fe-dynamic-request-path` | 1 | `'/api/orders?status=' + status` |
| `fe-be-shape-field-missing` | 1 | `pages/coupons.js:7` reads `res.data.nope`, which `CouponService::issueList` never returns |

### shape (M1–M3 — `scripts/response-shape.mjs`, asserted by `tests/response-shape.test.mjs`)

| target | expected | why |
| --- | --- | --- |
| `CouponController@lst` | `level: service`, keys `list, image, show` | delegates to `CouponService::issueList` (the 69% case) |
| `CouponController@deep` | `level: unresolved`, `reason: depth-cap` | service delegates again — beyond controller → service |
| `OrderController@index` | `level: local`, keys `ok, method` | literal array in the controller (the 6% case) |
| `ReportController@nope` | `level: unresolved`, `reason: method-not-found` | the method does not exist |
| `CouponController@fromRepo` | depth 2 → `unresolved/depth-cap`; `maxDepth: 3` → `level: repo`, keys `rows, count` | third hop into `OrderRepository::rows` (M4 mechanics work) — and `shapeIsComparable` **refuses** `repo` until §2.3 agreement evidence exists |
| reads for `/api/coupons` | `list` (real) + `nope` (never returned) | two hops: `api/index.js` → `pages/coupons.js` |
| reads for `/api/deep` | `unresolved` / `no-callsite-reads` | nobody calls it — an empty result must not become a pass |

Fe-be counts are unaffected by the shape work: 11 unique static paths, 8 matched
(73% pairing), still 2 ghosts / 1 wrong verb / 3 unused routes / 1 dynamic call.

```bash
node --test tests/fe-be-pair.test.mjs tests/response-shape.test.mjs
node scripts/shape-coverage.mjs <frontendDir> <backendDir>   # coverage on any pair
```
