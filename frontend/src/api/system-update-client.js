export function createSystemUpdateClient(http) {
  return {
    get() { return http.get("/api/system/update"); },
    check() { return http.post("/api/system/update/check", {}); },
    apply(targetCommit, ifRequestId) {
      return http.post("/api/system/update/apply", { targetCommit, ifRequestId });
    },
  };
}
