export function createMemoryClient(http) {
  return {
    list(agentId) { return http.get(`/api/agents/${agentId}/memory`); },
    get(agentId, slug) { return http.get(`/api/agents/${agentId}/memory/${encodeURIComponent(slug)}`); },
    create(agentId, body) { return http.post(`/api/agents/${agentId}/memory`, body); },
    update(agentId, slug, body) { return http.patch(`/api/agents/${agentId}/memory/${encodeURIComponent(slug)}`, body); },
    remove(agentId, slug) { return http.delete(`/api/agents/${agentId}/memory/${encodeURIComponent(slug)}`); },
  };
}
