<?php

namespace App\Repositories;

class OrderRepository
{
    /** Hop-3 shape (M4): only reachable when the resolver is asked for maxDepth: 3,
     *  and even then `shapeIsComparable` refuses level `repo` until §2.3's agreement
     *  evidence says these are response keys rather than row fields. */
    public function rows()
    {
        return ['rows' => 1, 'count' => 2];
    }
}
