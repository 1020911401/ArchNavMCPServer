// Caller side of the shape check: reads fields off the response (M2/M3 ground truth).
import { coupons } from '../api/index.js';

export function showCoupons() {
  return coupons().then((res) => ({
    list: res.data.list,      // returned by CouponService::issueList
    missing: res.data.nope,   // NEVER returned -> fe-be-shape-field-missing = 1
  }));
}
