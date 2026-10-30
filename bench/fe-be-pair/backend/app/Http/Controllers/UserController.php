<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;

class UserController
{
    public function index()
    {
        // UserController::index — shape lives in a service, like a real handler
        return response()->json(['ok' => true, 'method' => 'index']);
    }
    public function update()
    {
        // UserController::update — shape lives in a service, like a real handler
        return response()->json(['ok' => true, 'method' => 'update']);
    }
}
