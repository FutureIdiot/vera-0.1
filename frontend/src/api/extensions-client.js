export const extensionsAvailable = true;

export function createExtensionsClient(http) {
  return {
    list() { return http.get("/api/extensions"); },
    register(sourcePath) { return http.post("/api/extensions/register", { sourcePath }); },
    unload(extensionId, ifMatch = null) {
      const query = ifMatch ? `?ifMatch=${encodeURIComponent(ifMatch)}` : "";
      return http.delete(`/api/extensions/${encodeURIComponent(extensionId)}${query}`);
    },
    listAgent(agentId) { return http.get(`/api/agents/${encodeURIComponent(agentId)}/extensions`); },
    bindAgent(agentId, extensionId, body) {
      return http.post(`/api/agents/${encodeURIComponent(agentId)}/extensions/${encodeURIComponent(extensionId)}/bind`, body);
    },
    callMcp(agentId, extensionId, body) {
      return http.post(`/api/agents/${encodeURIComponent(agentId)}/extensions/${encodeURIComponent(extensionId)}/mcp`, body);
    },
    unbindAgent(agentId, extensionId, ifMatch) {
      const query = ifMatch ? `?ifMatch=${encodeURIComponent(ifMatch)}` : "";
      return http.delete(`/api/agents/${encodeURIComponent(agentId)}/extensions/${encodeURIComponent(extensionId)}/bind${query}`);
    },
  };
}
