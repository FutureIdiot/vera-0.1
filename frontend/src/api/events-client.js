function joinUrl(baseUrl, path) {
  return new URL(path, `${baseUrl.replace(/\/$/, "")}/`).toString();
}

export function createEventsClient(platform) {
  return {
    async connect({ since, onEvent, onOpen, onError } = {}) {
      const gatewayUrl = await platform.getGatewayUrl();
      const params = new URLSearchParams();
      if (since !== undefined && since !== null) params.set("since", String(since));
      const query = params.toString();
      const source = platform.createEventSource(joinUrl(gatewayUrl, `/api/events${query ? `?${query}` : ""}`));
      source.onopen = () => onOpen?.();
      source.onerror = (event) => onError?.(event);
      source.onmessage = (event) => {
        try {
          onEvent?.(JSON.parse(event.data));
        } catch {
          // Malformed frames are ignored; the next valid seq remains authoritative.
        }
      };
      return source;
    },
  };
}
