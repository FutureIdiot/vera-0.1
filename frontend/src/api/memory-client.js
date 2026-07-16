export function createMemoryClient(http) {
  return {
    list(agentId) { return http.get(`/api/agents/${agentId}/memory`); },
    get(agentId, slug) { return http.get(`/api/agents/${agentId}/memory/${encodeURIComponent(slug)}`); },
    create(agentId, body) { return http.post(`/api/agents/${agentId}/memory`, body); },
    update(agentId, slug, body) { return http.patch(`/api/agents/${agentId}/memory/${encodeURIComponent(slug)}`, body); },
    remove(agentId, slug, ifMatch) {
      const query = new URLSearchParams({ ifMatch });
      return http.delete(`/api/agents/${agentId}/memory/${encodeURIComponent(slug)}?${query}`);
    },
    getConfig(agentId) { return http.get(`/api/agents/${agentId}/memory/_config`); },
    patchConfig(agentId, body) { return http.patch(`/api/agents/${agentId}/memory/_config`, body); },
    getOptions(agentId) { return http.get(`/api/agents/${agentId}/memory/_options`); },
    getStatus(agentId) { return http.get(`/api/agents/${agentId}/memory/_status`); },
    enqueueDigest(agentId, body) { return http.post(`/api/agents/${agentId}/memory/_digest`, body); },
    enqueueDream(agentId, body) { return http.post(`/api/agents/${agentId}/memory/_dream`, body); },
  };
}
