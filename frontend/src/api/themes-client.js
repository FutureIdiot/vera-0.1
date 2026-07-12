export function createThemesClient(http) {
  return {
    list() { return http.get("/api/themes"); },
    get(themeId) { return http.get(`/api/themes/${encodeURIComponent(themeId)}`); },
    create(theme) { return http.post("/api/themes", { theme }); },
    update(themeId, patch) { return http.patch(`/api/themes/${encodeURIComponent(themeId)}`, patch); },
    remove(themeId) { return http.delete(`/api/themes/${encodeURIComponent(themeId)}`); },
    previewImport(body) { return http.post("/api/themes/import", body); },
    exportPath(themeId, format) {
      return `/api/themes/${encodeURIComponent(themeId)}/export?format=${encodeURIComponent(format)}`;
    },
    exportProfile() { return http.get("/api/settings/appearance-profile/export"); },
    previewProfile(body) { return http.post("/api/settings/appearance-profile/import", body); },
  };
}
