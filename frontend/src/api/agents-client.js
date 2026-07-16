export function createAgentsClient(http) {
  return {
    list() { return http.get("/api/agents"); },
    create(body) { return http.post("/api/agents", body); },
    update(agentId, body) { return http.patch(`/api/agents/${agentId}`, body); },
    remove(agentId) { return http.delete(`/api/agents/${agentId}`); },
    listStates(agentId) {
      const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
      return http.get(`/api/agent-states${query}`);
    },
    listUnitBindings(agentId, kind) {
      return http.get(`/api/agents/${agentId}/unit-bindings?kind=${encodeURIComponent(kind)}`);
    },
  };
}
