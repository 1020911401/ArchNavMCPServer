// Second-stage ground truth: the /api/deep handler's shape is NOT comparable
// (depth-cap), so the rule falls back to declaration search on the read fields.
import { deepShape } from '../api/index.js';

export function showDeep() {
  return deepShape().then((res) => ({
    ghost: res.data.ghostField,   // declared NOWHERE in the fixture backend -> confirmed finding
    image: res.data.image,        // declared in CouponService::issueList (another handler) -> pairing question, NOT reported
  }));
}
