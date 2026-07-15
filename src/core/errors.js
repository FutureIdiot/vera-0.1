// 统一错误类型。code 枚举与 HTTP 状态码映射见 api-contract.md 一、通用约定。

export const STATUS_BY_CODE = {
  invalid_request: 400,
  invalid_memory_file: 422,
  not_found: 404,
  conflict: 409,
  memory_cursor_invalid: 400,
  memory_cursor_expired: 410,
  memory_retrieval_unavailable: 503,
  memory_job_active: 409,
  memory_task_unavailable: 409,
  memory_provider_unsupported: 422,
  memory_provider_unavailable: 503,
  adapter_unavailable: 502,
  internal: 500,
};

// HTTP/业务层错误：agents/、spaces/、api/ 里的服务函数抛这个，
// api/http.js 的 asHandler 捕获后按 code 映射状态码。
export class ApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// adapter 层错误：docs/adapter-interface.md 二、错误契约。
export class AdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}
