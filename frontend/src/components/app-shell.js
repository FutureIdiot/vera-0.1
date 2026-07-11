import { createSpaceNavigator } from "./space-navigator.js";

export function createAppShell({ root, platform, runtime } = {}) {
  let currentSpace = runtime.getBootstrap().spaces[0] ?? null;
  let navigatorOpen = false;
  let pinned = window.localStorage.getItem("vera.navigatorPinned") === "true";

  const shell = document.createElement("section");
  shell.className = "vera-shell";

  const header = document.createElement("header");
  header.className = "vera-shell__header";

  const spaceSettings = document.createElement("a");
  spaceSettings.className = "vera-icon-button vera-shell__space-settings";
  spaceSettings.textContent = "Space";
  spaceSettings.setAttribute("aria-label", "当前 Space 设置");

  const title = document.createElement("button");
  title.type = "button";
  title.className = "vera-shell__title";
  title.addEventListener("click", openNavigator);

  const settings = document.createElement("a");
  settings.className = "vera-icon-button";
  settings.href = "#/settings";
  settings.textContent = "设置";
  settings.setAttribute("aria-label", "全局 Settings");

  const connection = document.createElement("span");
  connection.className = "vera-shell__connection";
  connection.hidden = true;

  const main = document.createElement("div");
  main.className = "vera-shell__main";
  const backdrop = document.createElement("button");
  backdrop.type = "button";
  backdrop.className = "vera-navigator-backdrop";
  backdrop.setAttribute("aria-label", "关闭 Space 导航");
  backdrop.addEventListener("click", closeNavigator);

  const navigator = createSpaceNavigator({
    platform,
    runtime,
    currentSpaceId: currentSpace?.id,
    pinned,
    onClose: closeNavigator,
  });
  navigator.element.addEventListener("vera:navigator-pin", (event) => {
    pinned = event.detail.pinned;
    applyNavigatorState();
  });
  header.append(spaceSettings, title, settings, connection);
  shell.append(navigator.element, header, main, backdrop);
  root.replaceChildren(shell);

  function setSpace(nextSpace) {
    currentSpace = nextSpace;
    title.textContent = currentSpace?.name ?? "选择 Space";
    title.setAttribute("aria-label", currentSpace ? `打开 ${currentSpace.name} 的 Space 导航` : "打开 Space 导航");
    spaceSettings.href = currentSpace ? `#/spaces/${encodeURIComponent(currentSpace.id)}/settings` : "#/spaces";
    spaceSettings.toggleAttribute("aria-disabled", !currentSpace);
    navigator.setCurrentSpace(currentSpace?.id ?? null);
  }

  function setConnection(message, tone = "muted") {
    connection.textContent = message ?? "";
    connection.dataset.tone = tone;
    connection.hidden = !message;
  }

  function applyNavigatorState() {
    const desktop = window.matchMedia("(min-width: 768px)").matches;
    shell.classList.toggle("is-navigator-open", navigatorOpen || (pinned && desktop));
    shell.classList.toggle("is-navigator-pinned", pinned && desktop);
    backdrop.hidden = !(navigatorOpen && !(pinned && desktop));
  }

  function openNavigator() {
    navigatorOpen = true;
    applyNavigatorState();
  }

  function closeNavigator() {
    navigatorOpen = false;
    applyNavigatorState();
    if (window.location.hash === "#/spaces") {
      window.location.hash = currentSpace ? `#/spaces/${encodeURIComponent(currentSpace.id)}` : "#/";
    }
  }

  function setRoute(route) {
    const bootstrap = runtime.getBootstrap();
    const routeSpace = route.spaceId ? bootstrap.spaces.find((space) => space.id === route.spaceId) : null;
    if (routeSpace) setSpace(routeSpace);
    shell.dataset.routeScope = route.name === "space" ? "chat" : "management";
    spaceSettings.hidden = route.name !== "space" || !currentSpace;
    title.hidden = route.name === "settings";
    settings.hidden = route.name === "settings";
    if (route.name === "spaces") openNavigator();
    else if (!pinned) { navigatorOpen = false; applyNavigatorState(); }
  }

  const onOnline = () => setConnection(null);
  const onOffline = () => setConnection("离线", "danger");
  const onKeyDown = (event) => { if (event.key === "Escape" && navigatorOpen) closeNavigator(); };
  const onResize = () => applyNavigatorState();
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResize);
  const unsubscribeRuntime = runtime.subscribe((envelope) => {
    if (envelope.type === "runtime.connection") {
      if (envelope.data.status === "open" && window.navigator.onLine) setConnection(null);
      else if (window.navigator.onLine) setConnection(envelope.data.status === "reconnecting" ? "重连中" : "连接中");
    } else if (envelope.type === "runtime.degraded") setConnection("同步失败", "danger");
    else if (envelope.type === "space.updated" && envelope.data?.space?.id === currentSpace?.id) setSpace(envelope.data.space);
    else if (envelope.type === "runtime.reset") {
      const next = envelope.data.bootstrap.spaces.find((space) => space.id === currentSpace?.id) ?? envelope.data.bootstrap.spaces[0] ?? null;
      setSpace(next);
    }
  });
  if (!window.navigator.onLine) onOffline();
  setSpace(currentSpace);
  applyNavigatorState();

  return {
    element: shell,
    outlet: main,
    setRoute,
    setSpace,
    setConnection,
    openNavigator,
    getCurrentSpace() { return currentSpace; },
    destroy() {
      unsubscribeRuntime();
      navigator.destroy();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
      shell.remove();
    },
  };
}
