export function mountSettingsView({ root, shell } = {}) {
  root.dataset.routeScope = "management";
  const header = document.createElement("header");
  header.className = "vera-management-header";
  const back = document.createElement("a");
  const currentSpace = shell?.getCurrentSpace?.();
  back.href = currentSpace ? `#/spaces/${encodeURIComponent(currentSpace.id)}` : "#/";
  back.className = "vera-text-button";
  back.textContent = "返回聊天";
  const title = document.createElement("h1");
  title.textContent = "Settings";
  header.append(back, title);

  const notice = document.createElement("section");
  notice.className = "vera-management-empty";
  const text = document.createElement("p");
  text.textContent = "全局 Account、Memory、Appearance 与系统管理将在 F4 开放。";
  notice.appendChild(text);
  root.append(header, notice);
  return () => root.replaceChildren();
}
