export function createAccountsClient(http) {
  return {
    list(agentId) {
      const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
      return http.get(`/api/accounts${query}`);
    },
    create(agentId, body) { return http.post(`/api/agents/${agentId}/accounts`, body); },
    update(accountId, body) { return http.patch(`/api/accounts/${accountId}`, body); },
    remove(accountId) { return http.delete(`/api/accounts/${accountId}`); },
  };
}
