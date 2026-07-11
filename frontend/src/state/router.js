export function parseRoute(hash = "") {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  const path = normalized.startsWith("/") ? normalized : `/${normalized}`;
  if (path === "/" || path === "//") return { name: "space", spaceId: null };
  const match = path.match(/^\/spaces\/([^/]+)\/?$/);
  if (match) {
    try {
      return { name: "space", spaceId: decodeURIComponent(match[1]) };
    } catch {
      return { name: "not-found", path };
    }
  }
  return { name: "not-found", path };
}

export function createAppRouter({
  root,
  platform,
  runtime,
  windowTarget = window,
  loadSpaceView = () => import("../views/space-view.js"),
} = {}) {
  let activeCleanup = null;
  let started = false;
  let transition = 0;

  async function render() {
    const route = parseRoute(windowTarget.location.hash);
    const currentTransition = ++transition;
    activeCleanup?.();
    activeCleanup = null;
    root.replaceChildren();

    if (route.name === "space") {
      const routeRoot = windowTarget.document?.createElement?.("main") ?? document.createElement("main");
      routeRoot.className = "vera-route";
      root.appendChild(routeRoot);
      const module = await loadSpaceView();
      if (currentTransition !== transition) {
        routeRoot.remove();
        return;
      }
      const cleanup = await module.mountSpaceView({ root: routeRoot, platform, runtime, spaceId: route.spaceId });
      if (currentTransition !== transition) {
        cleanup?.();
        routeRoot.remove();
        return;
      }
      activeCleanup = () => {
        cleanup?.();
        routeRoot.remove();
      };
      return;
    }

    const message = windowTarget.document?.createElement?.("p") ?? document.createElement("p");
    message.className = "vera-route-error";
    message.textContent = "页面不存在";
    root.appendChild(message);
    activeCleanup = () => message.remove();
  }

  function onHashChange() {
    const expectedTransition = transition + 1;
    void render().catch((err) => {
      if (transition !== expectedTransition) return;
      root.replaceChildren();
      const message = windowTarget.document?.createElement?.("p") ?? document.createElement("p");
      message.className = "vera-route-error";
      message.textContent = `页面加载失败：${err.message}`;
      root.appendChild(message);
    });
  }

  return {
    async start() {
      if (started) return;
      started = true;
      windowTarget.addEventListener("hashchange", onHashChange);
      await render();
    },
    stop() {
      if (!started) return;
      started = false;
      transition += 1;
      windowTarget.removeEventListener("hashchange", onHashChange);
      activeCleanup?.();
      activeCleanup = null;
      root.replaceChildren();
    },
  };
}
