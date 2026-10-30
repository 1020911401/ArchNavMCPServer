<?php

namespace App\Services;

class CouponService
{
    /** Delegated shape: keys live here, not in the controller (34/49 real handlers do this). */
    public function issueList()
    {
        $data = [];
        $data['list'] = [['id' => 1, 'title' => 'welcome']];
        $data['image'] = 'coupon.png';
        $data['show'] = 1;
        return $data;
    }

    /** Delegates again: past the charter's depth cap (controller -> service only). */
    public function nested()
    {
        return app('json')->success($this->repository->inner());
    }

    public function inner()
    {
        return ['never' => 'reached'];
    }
}
