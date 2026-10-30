<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;

class HealthController
{
    public function index()
    {
        // HealthController::index — shape lives in a service, like a real handler
        return response()->json(['ok' => true, 'method' => 'index']);
    }
}
