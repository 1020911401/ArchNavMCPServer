<?php

namespace App\Http\Controllers;

use App\Services\CouponService;
use Illuminate\Http\JsonResponse;

class CouponController
{
    private $service;

    public function __construct(CouponService $service)
    {
        $this->service = $service;
    }

    /** Shape is delegated: resolveHandlerShape must return level 'service'. */
    public function lst()
    {
        return app('json')->success($this->service->issueList());
    }

    /** Two hops of delegation: resolveHandlerShape must stop at level 'unresolved'. */
    public function deep()
    {
        return app('json')->success($this->service->nested());
    }

    /** M4: three hops — level `repo` only when maxDepth: 3 is asked for, and never
     *  comparable (`shapeIsComparable` whitelists local|service) until §2.3 evidence. */
    public function fromRepo()
    {
        return app('json')->success($this->service->viaRepo());
    }
}
