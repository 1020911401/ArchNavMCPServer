<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;

class ProductController
{
    public function index()
    {
        // ProductController::index — shape lives in a service, like a real handler
        return response()->json(['ok' => true, 'method' => 'index']);
    }
    public function buy()
    {
        // ProductController::buy — shape lives in a service, like a real handler
        return response()->json(['ok' => true, 'method' => 'buy']);
    }
}
