<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;

class ReportController
{
    public function export()
    {
        // ReportController::export — shape lives in a service, like a real handler
        return response()->json(['ok' => true, 'method' => 'export']);
    }
}
