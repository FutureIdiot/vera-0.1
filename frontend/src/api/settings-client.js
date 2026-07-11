export function createSettingsClient(http) {
  return {
    get() { return http.get("/api/settings"); },
    update(settings) { return http.patch("/api/settings", { settings }); },
  };
}
