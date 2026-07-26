export function createProjectsClient(http) {
  return {
    listProjects() {
      return http.get("/api/projects");
    },
    fetchProject(projectId) {
      return http.get(`/api/projects/${encodeURIComponent(projectId)}`);
    },
    createProject(body) {
      return http.post("/api/projects", body);
    },
    updateProject(projectId, body) {
      return http.patch(`/api/projects/${encodeURIComponent(projectId)}`, body);
    },
    deleteProject(projectId) {
      return http.delete(`/api/projects/${encodeURIComponent(projectId)}`);
    },
  };
}
