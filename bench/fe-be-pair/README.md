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

Run: `node --test tests/fe-be-pair.test.mjs`
