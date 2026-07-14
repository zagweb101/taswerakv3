// ====================================================================
// Taswerak — API Response Helpers
//
// Standardized response format for ALL API routes:
//   Success: { ok: true, data?: T, message?: string }
//   Error:   { ok: false, error: string, code?: string }
//
// Usage:
//   import { apiOk, apiError, apiCreated, apiPaginated } from "@/lib/api-response";
//   return apiOk(data);
//   return apiError("غير مسجّل", 401);
//   return apiCreated(newResource);
// ====================================================================

import { NextResponse } from "next/server";

export interface ApiSuccessResponse<T = unknown> {
  ok: true;
  data?: T;
  message?: string;
}

export interface ApiErrorResponse {
  ok: false;
  error: string;
  code?: string;
}

/** 200 OK with optional data and message */
export function apiOk<T>(data?: T, message?: string, init?: ResponseInit) {
  return NextResponse.json<ApiSuccessResponse<T>>(
    { ok: true, ...(data !== undefined && { data }), ...(message && { message }) },
    { status: 200, ...init }
  );
}

/** 201 Created with the new resource */
export function apiCreated<T>(data: T, message?: string, init?: ResponseInit) {
  return NextResponse.json<ApiSuccessResponse<T>>(
    { ok: true, data, ...(message && { message }) },
    { status: 201, ...init }
  );
}

/** Error response with status code and optional machine-readable code */
export function apiError(
  error: string,
  status = 400,
  code?: string,
  init?: ResponseInit
) {
  return NextResponse.json<ApiErrorResponse>(
    { ok: false, error, ...(code && { code }) },
    { status, ...init }
  );
}

// ---------- Convenience factories for common cases ----------

export const apiUnauthorized = (msg = "غير مسجّل") => apiError(msg, 401, "UNAUTHORIZED");
export const apiForbidden = (msg = "صلاحيات غير كافية") => apiError(msg, 403, "FORBIDDEN");
export const apiNotFound = (msg = "غير موجود") => apiError(msg, 404, "NOT_FOUND");
export const apiConflict = (msg = "تعارض في البيانات") => apiError(msg, 409, "CONFLICT");
export const apiTooManyRequests = (msg = "محاولات كثيرة") =>
  apiError(msg, 429, "RATE_LIMITED");
export const apiInternalError = (msg = "حدث خطأ غير متوقع") =>
  apiError(msg, 500, "INTERNAL_ERROR");
export const apiServiceUnavailable = (msg = "الخدمة غير متاحة حالياً") =>
  apiError(msg, 503, "SERVICE_UNAVAILABLE");
