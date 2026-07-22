export function createAccountsClient(http) {
  return {
    list() { return http.get("/api/accounts"); },
    get(accountId) { return http.get(`/api/accounts/${encodeURIComponent(accountId)}`); },
    create(body) { return http.post("/api/accounts", body); },
    update(accountId, body) { return http.patch(`/api/accounts/${accountId}`, body); },
    updateModel(accountId, body) {
      return http.request("PUT", `/api/accounts/${encodeURIComponent(accountId)}/model`, body);
    },
    remove(accountId) { return http.delete(`/api/accounts/${accountId}`); },
    rotateAccessKey(accountId) { return http.post(`/api/accounts/${encodeURIComponent(accountId)}/access-key/rotate`, {}); },
    revokeAccessKey(accountId) { return http.delete(`/api/accounts/${encodeURIComponent(accountId)}/access-key`); },
  };
}
