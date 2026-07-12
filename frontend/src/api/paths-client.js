export function createPathsClient(http) {
  return {
    get() { return http.get("/api/paths"); },
    validate(key, value) { return http.post("/api/paths/validate", { key, value }); },
    migrate(key, target) { return http.post("/api/paths/migrate", { key, target }); },
  };
}
