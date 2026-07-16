export function createSpacesClient(http) {
  return {
    fetchBootstrap() {
      return http.get("/api/bootstrap");
    },
    fetchTimeline(spaceId, { before, limit } = {}) {
      const params = new URLSearchParams();
      if (before) params.set("before", before);
      if (limit) params.set("limit", String(limit));
      const query = params.toString();
      return http.get(`/api/spaces/${spaceId}/timeline${query ? `?${query}` : ""}`);
    },
    listSpaces({ archived } = {}) {
      const query = archived === true ? "?archived=true" : archived === "all" ? "?archived=all" : "";
      return http.get(`/api/spaces${query}`);
    },
    postMessage(spaceId, message) {
      return http.post(`/api/spaces/${spaceId}/messages`, message);
    },
    startNewSession(spaceId, requestId) {
      return http.post(`/api/spaces/${spaceId}/session/_new`, { requestId });
    },
    compactSession(spaceId, requestId) {
      return http.post(`/api/spaces/${spaceId}/session/_compact`, { requestId });
    },
    fetchCompactionJob(spaceId, jobId) {
      return http.get(`/api/spaces/${spaceId}/session/_compact/jobs/${jobId}`);
    },
    listSessions(spaceId, { status } = {}) {
      const query = status ? `?status=${encodeURIComponent(status)}` : "";
      return http.get(`/api/spaces/${spaceId}/sessions${query}`);
    },
    fetchSessionTimeline(spaceId, spaceSessionId, { before, limit } = {}) {
      const params = new URLSearchParams();
      if (before) params.set("before", before);
      if (limit) params.set("limit", String(limit));
      const query = params.toString();
      return http.get(`/api/spaces/${spaceId}/sessions/${spaceSessionId}/timeline${query ? `?${query}` : ""}`);
    },
    answerApproval(approvalId, answer) {
      return http.post(`/api/approvals/${approvalId}/answer`, { answer });
    },
    cancelRun(runId) {
      return http.post(`/api/runs/${runId}/cancel`, {});
    },
    createSpace(body) {
      return http.post("/api/spaces", body);
    },
    updateSpace(spaceId, body) {
      return http.patch(`/api/spaces/${spaceId}`, body);
    },
    archiveSpace(spaceId) {
      return http.post(`/api/spaces/${spaceId}/archive`, {});
    },
    restoreSpace(spaceId) {
      return http.post(`/api/spaces/${spaceId}/restore`, {});
    },
  };
}
