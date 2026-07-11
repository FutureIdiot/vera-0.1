const unsupported = Object.freeze({ unsupported: true });

function subscribeWindow(type, listener) {
  window.addEventListener(type, listener);
  return () => window.removeEventListener(type, listener);
}

function pickFileWithInput(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      resolve(file ? { path: file.name, name: file.name, mime: file.type } : unsupported);
    }, { once: true });
    input.addEventListener("cancel", () => resolve(unsupported), { once: true });
    input.click();
  });
}

export function createWebPlatform() {
  return {
    id: "web",
    async getGatewayUrl() {
      return window.location.origin;
    },
    async setGatewayUrl() {
      return unsupported;
    },
    fetch(url, init) {
      return window.fetch(url, init);
    },
    createEventSource(url, opts) {
      return new window.EventSource(url, opts);
    },
    secureStorage: {
      async get(key) { return window.localStorage.getItem(key); },
      async set(key, value) { window.localStorage.setItem(key, value); },
      async remove(key) { window.localStorage.removeItem(key); },
    },
    notifications: {
      async requestPermission() {
        if (!("Notification" in window)) return "unsupported";
        const permission = await window.Notification.requestPermission();
        return permission === "granted" ? "granted" : "denied";
      },
      async notify({ title, body }) {
        if (!("Notification" in window) || window.Notification.permission !== "granted") return "unsupported";
        new window.Notification(title, { body });
        return "shown";
      },
    },
    async pickFile({ accept } = {}) {
      return pickFileWithInput(accept);
    },
    async pickDirectory() {
      if (!("showDirectoryPicker" in window)) return unsupported;
      const handle = await window.showDirectoryPicker();
      return { path: handle.name };
    },
    keyboard: {
      insets: { bottom: 0, top: 0 },
      onInsetChange() { return () => {}; },
    },
    backButton: {
      onBack(listener) { return subscribeWindow("popstate", listener); },
      consume() { window.history.back(); },
    },
    haptics: {
      async tap() { return unsupported; },
      async notify() { return unsupported; },
    },
    externalAuth: {
      async open(url) {
        window.location.assign(url);
        return { redirected: url };
      },
      onRedirect(listener) {
        const offHash = subscribeWindow("hashchange", listener);
        const offPop = subscribeWindow("popstate", listener);
        return () => { offHash(); offPop(); };
      },
    },
    externalLink: {
      async open(url) {
        return window.open(url, "_blank", "noopener,noreferrer") ? "opened" : "unsupported";
      },
    },
  };
}
