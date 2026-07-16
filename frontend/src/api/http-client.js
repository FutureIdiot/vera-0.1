export class HttpError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function joinUrl(baseUrl, path) {
  return new URL(path, `${baseUrl.replace(/\/$/, "")}/`).toString();
}

export function createHttpClient(platform) {
  async function request(method, path, body) {
    const gatewayUrl = await platform.getGatewayUrl();
    const response = await platform.fetch(joinUrl(gatewayUrl, path), {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new HttpError(`${method} ${path} returned invalid JSON`, { status: response.status });
      }
    }
    if (!response.ok) {
      throw new HttpError(json?.error?.message || `${method} ${path} failed with ${response.status}`, {
        status: response.status,
        code: json?.error?.code,
        details: json?.error,
      });
    }
    return json;
  }

  return {
    request,
    get(path) { return request("GET", path); },
    post(path, body) { return request("POST", path, body); },
    patch(path, body) { return request("PATCH", path, body); },
    delete(path, body) { return request("DELETE", path, body); },
  };
}
