export function createStatusClient(http) {
  return {
    get() { return http.get("/api/status"); },
  };
}
