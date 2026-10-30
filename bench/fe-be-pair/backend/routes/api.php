<?php

use App\Http\Controllers\OrderController;
use App\Http\Controllers\ProductController;
use App\Http\Controllers\UserController;
use App\Http\Controllers\ReportController;
use App\Http\Controllers\HealthController;
use App\Http\Controllers\LegacyController;

Route::get('/api/orders', [OrderController::class, 'index']);
Route::post('/api/orders', [OrderController::class, 'store']);
Route::get('/api/orders/{id}', [OrderController::class, 'show']);
Route::delete('/api/orders/{id}', [OrderController::class, 'destroy']);
Route::get('/api/products', [ProductController::class, 'index']);
Route::post('/api/products/{id}/buy', [ProductController::class, 'buy']);
Route::get('/api/users', [UserController::class, 'index']);
Route::put('/api/users/{id}', [UserController::class, 'update']);
Route::get('/api/wrong-method', [ReportController::class, 'export']);
Route::get('/api/health', [HealthController::class, 'index']);
Route::get('/api/legacy', [LegacyController::class, 'index']);
