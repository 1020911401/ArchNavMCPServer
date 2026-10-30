<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;

class OrderController
{
    public function index()
    {
        // OrderController::index — shape lives in a service, like a real handler
        return response()->json(['ok' => true, 'method' => 'index']);
    }
    public function store()
    {
        // OrderController::store — shape lives in a service, like a real handler
        return response()->json(['ok' => true, 'method' => 'store']);
    }
    public function show()
    {
        // OrderController::show — shape lives in a service, like a real handler
        return response()->json(['ok' => true, 'method' => 'show']);
    }
    public function destroy()
    {
        // OrderController::destroy — shape lives in a service, like a real handler
        return response()->json(['ok' => true, 'method' => 'destroy']);
    }
}
