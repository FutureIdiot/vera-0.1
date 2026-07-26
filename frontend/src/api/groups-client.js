export function createGroupsClient(http) {
  return {
    listGroups() {
      return http.get("/api/groups");
    },
    fetchGroup(groupId) {
      return http.get(`/api/groups/${encodeURIComponent(groupId)}`);
    },
    createGroup(body) {
      return http.post("/api/groups", body);
    },
    updateGroup(groupId, body) {
      return http.patch(`/api/groups/${encodeURIComponent(groupId)}`, body);
    },
    deleteGroup(groupId) {
      return http.delete(`/api/groups/${encodeURIComponent(groupId)}`);
    },
  };
}
