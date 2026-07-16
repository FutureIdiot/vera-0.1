import { createSpaceNavigator } from "./space-navigator.js";

const MANAGEMENT_ROUTES = new Set([
  "space-settings",
  "space-files",
  "settings",
  "accounts",
  "account-detail",
  "agent-detail",
  "agent-skills",
  "agent-hooks",
  "agent-mcp",
  "agent-data",
  "agent-memory-config",
  "agent-memory-library",
  "system-settings",
  "appearance",
  "path-settings",
  "control-center",
]);

export function isChatRouteName(routeName) {
  return routeName === "space" || routeName === "spaces";
}

function defaultManagementHeader(routeName, currentSpace) {
  const currentChat = currentSpace ? `#/spaces/${encodeURIComponent(currentSpace.id)}` : "#/";
  const defaults = {
    "space-settings": { title: "当前 Space 设置", backHref: currentChat, backLabel: "返回" },
    "space-files": { title: "Files", backHref: currentChat, backLabel: "返回" },
    settings: { title: "Settings", backHref: currentChat, backLabel: "返回" },
    accounts: { title: "Account", backHref: "#/settings", backLabel: "返回" },
    "account-detail": { title: "Account", backHref: "#/settings/accounts", backLabel: "返回" },
    "agent-detail": { title: "Agent", backHref: currentChat, backLabel: "返回" },
    "agent-skills": { title: "Skills", backHref: "#/agents", backLabel: "返回" },
    "agent-hooks": { title: "Hooks", backHref: "#/agents", backLabel: "返回" },
    "agent-mcp": { title: "MCP", backHref: "#/agents", backLabel: "返回" },
    "agent-data": { title: "Data", backHref: "#/agents", backLabel: "返回" },
    "agent-memory-config": { title: "Memory", backHref: "#/agents", backLabel: "返回" },
    "agent-memory-library": { title: "Memory Library", backHref: "#/agents", backLabel: "返回" },
    "system-settings": { title: "System", backHref: "#/settings", backLabel: "返回" },
    appearance: { title: "Appearance", backHref: "#/settings", backLabel: "返回" },
    "path-settings": { title: "Paths", backHref: "#/settings", backLabel: "返回" },
    "control-center": { title: "Control Center", backHref: "#/settings", backLabel: "返回" },
  };
  return defaults[routeName] ?? { title: "Vera", backHref: currentChat, backLabel: "返回" };
}

export function resolveShellHeader({ routeName, currentSpace, navigatorOpen = false, managementHeader = null } = {}) {
  if (isChatRouteName(routeName)) {
    return {
      leadingText: navigatorOpen ? "收起" : "目录",
      leadingHref: "#/spaces",
      leadingLabel: navigatorOpen ? "收起 Space 目录" : "打开 Space 目录",
      title: currentSpace?.name ?? "选择 Space",
      titleHref: currentSpace ? `#/spaces/${encodeURIComponent(currentSpace.id)}/settings` : "#/spaces",
      titleLabel: currentSpace ? `打开 ${currentSpace.name} 的设置` : "选择 Space",
      titleIsHeading: false,
      settingsVisible: true,
    };
  }
  const header = managementHeader ?? defaultManagementHeader(routeName, currentSpace);
  return {
    leadingText: header.backLabel ?? "返回",
    leadingHref: header.backHref,
    leadingLabel: header.backLabel ?? "返回",
    title: header.title,
    titleHref: null,
    titleLabel: header.title,
    titleIsHeading: true,
    settingsVisible: false,
  };
}

export function resolveNavigatorState({ routeName, navigatorOpen = false } = {}) {
  return { visible: isChatRouteName(routeName) && navigatorOpen };
}

export function createAppShell({ root, platform, runtime } = {}) {
  let currentSpace = runtime.getBootstrap().spaces[0] ?? null;
  let activeRouteName = "space";
  let navigatorOpen = false;
  let managementHeader = null;

  const shell = document.createElement("section");
  shell.className = "vera-shell";

  const header = document.createElement("header");
  header.className = "vera-shell__header";

  const leading = document.createElement("a");
  leading.className = "vera-icon-button vera-shell__leading";
  leading.addEventListener("click", (event) => {
    if (!isChatRoute()) return;
    event.preventDefault();
    toggleNavigator();
  });

  const title = document.createElement("a");
  title.className = "vera-shell__title";

  const settings = document.createElement("a");
  settings.className = "vera-icon-button";
  settings.href = "#/settings";
  settings.textContent = "设置";
  settings.setAttribute("aria-label", "全局 Settings");

  const connection = document.createElement("span");
  connection.className = "vera-shell__connection";
  connection.setAttribute("role", "status");
  connection.setAttribute("aria-live", "polite");
  connection.hidden = true;

  const main = document.createElement("div");
  main.className = "vera-shell__main";

  const navigator = createSpaceNavigator({
    platform,
    runtime,
    currentSpaceId: currentSpace?.id,
  });

  header.append(leading, title, settings, connection);
  shell.append(navigator.element, header, main);
  root.replaceChildren(shell);

  function isChatRoute() {
    return isChatRouteName(activeRouteName);
  }

  function updateHeader() {
    const headerState = resolveShellHeader({ routeName: activeRouteName, currentSpace, navigatorOpen, managementHeader });
    leading.textContent = headerState.leadingText;
    leading.href = headerState.leadingHref;
    leading.setAttribute("aria-label", headerState.leadingLabel);
    title.textContent = headerState.title;
    if (headerState.titleHref) title.href = headerState.titleHref;
    else title.removeAttribute("href");
    title.setAttribute("aria-label", headerState.titleLabel);
    title.toggleAttribute("role", headerState.titleIsHeading);
    if (headerState.titleIsHeading) {
      title.setAttribute("role", "heading");
      title.setAttribute("aria-level", "1");
    } else {
      title.removeAttribute("role");
      title.removeAttribute("aria-level");
    }
    settings.hidden = !headerState.settingsVisible;
  }

  function setSpace(nextSpace) {
    currentSpace = nextSpace;
    navigator.setCurrentSpace(currentSpace?.id ?? null);
    updateHeader();
  }

  function setConnection(message, tone = "muted") {
    connection.textContent = message ?? "";
    connection.dataset.tone = tone;
    connection.hidden = !message;
  }

  function applyNavigatorState() {
    const { visible } = resolveNavigatorState({ routeName: activeRouteName, navigatorOpen });
    shell.classList.toggle("is-navigator-open", visible);
    navigator.element.toggleAttribute("inert", !visible);
    navigator.element.setAttribute("aria-hidden", String(!visible));
    updateHeader();
  }

  function openNavigator() {
    if (!isChatRoute()) return;
    navigatorOpen = true;
    applyNavigatorState();
    navigator.focusFirst();
  }

  function closeNavigator() {
    if (!navigatorOpen) return;
    navigatorOpen = false;
    applyNavigatorState();
    leading.focus();
    if (window.location.hash === "#/spaces") {
      window.location.hash = currentSpace ? `#/spaces/${encodeURIComponent(currentSpace.id)}` : "#/";
    }
  }

  function toggleNavigator() {
    if (navigatorOpen) closeNavigator();
    else openNavigator();
  }

  function setManagementHeader(nextHeader) {
    managementHeader = nextHeader;
    if (MANAGEMENT_ROUTES.has(activeRouteName)) updateHeader();
  }

  function setRoute(route) {
    activeRouteName = route.name;
    managementHeader = null;
    const bootstrap = runtime.getBootstrap();
    const routeSpace = route.spaceId ? bootstrap.spaces.find((space) => space.id === route.spaceId) : null;
    if (routeSpace) setSpace(routeSpace);
    shell.dataset.routeScope = isChatRoute() ? "chat" : "management";
    if (route.name === "spaces") navigatorOpen = true;
    else if (!isChatRoute()) navigatorOpen = false;
    updateHeader();
    applyNavigatorState();
    if (route.name === "spaces") navigator.focusFirst();
  }

  const onOnline = () => setConnection(null);
  const onOffline = () => setConnection("离线", "danger");
  const onKeyDown = (event) => {
    if (event.key === "Escape" && navigatorOpen) closeNavigator();
  };
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
    setManagementHeader,
    openNavigator,
    toggleNavigator,
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
