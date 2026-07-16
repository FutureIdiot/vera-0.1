export const FILE_ACCEPT = [
  ".txt", ".md", ".json", ".csv", ".pdf", ".png", ".jpg", ".jpeg",
  ".gif", ".webp", ".zip", ".docx", ".xlsx", ".pptx",
].join(",");

export function createFilesClient(http) {
  return {
    list(spaceId) {
      return http.get(`/api/spaces/${spaceId}/files`);
    },
    get(spaceId, fileId) {
      return http.get(`/api/spaces/${spaceId}/files/${fileId}`);
    },
    upload(spaceId, selection) {
      return http.raw("POST", `/api/spaces/${spaceId}/files`, {
        headers: {
          "Content-Type": selection.mime || "application/octet-stream",
          "X-Vera-File-Name": encodeURIComponent(selection.name),
        },
        body: selection.source,
      });
    },
    updateSharing(spaceId, fileId, sharedSpaceIds, ifMatch) {
      return http.patch(`/api/spaces/${spaceId}/files/${fileId}`, { sharedSpaceIds, ifMatch });
    },
    delete(spaceId, fileId, ifMatch) {
      return http.delete(`/api/spaces/${spaceId}/files/${fileId}?ifMatch=${encodeURIComponent(ifMatch)}`);
    },
    downloadHref(spaceId, fileId) {
      return `/api/spaces/${encodeURIComponent(spaceId)}/files/${encodeURIComponent(fileId)}/download`;
    },
  };
}
