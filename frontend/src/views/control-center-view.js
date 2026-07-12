import { createHttpClient } from "../api/http-client.js";
import { createStatusClient } from "../api/status-client.js";
import { createNotice } from "../components/management-ui.js";
import { createPagePoller } from "../hooks/page-poller.js";

function item(label, value) {
  const row = document.createElement("div");
  row.className = "vera-status-row";
  const term = document.createElement("span");
  term.textContent = label;
  const detail = document.createElement("strong");
  detail.textContent = String(value ?? "—");
  row.append(term, detail);
  return row;
}

export async function mountControlCenterView({ root, platform, shell } = {}) {
  root.dataset.routeScope = "management";
  const client = createStatusClient(createHttpClient(platform));
  let disposed = false;
  shell?.setManagementHeader({ title: "Control Center", backHref: "#/settings", backLabel: "返回" });
  const content = document.createElement("div");
  content.className = "vera-management-content";
  const notice = createNotice("正在连接 gateway…");
  const panels = document.createElement("div");
  panels.className = "vera-status-grid";
  content.append(notice, panels);
  root.appendChild(content);

  function panel(title, rows) {
    const section = document.createElement("section");
    section.className = "vera-status-card";
    const heading = document.createElement("h2");
    heading.textContent = title;
    section.append(heading, ...rows);
    return section;
  }
  function render(status) {
    panels.replaceChildren(
      panel("Gateway", [item("版本", status.gateway.version), item("PID", status.gateway.pid), item("运行时长", `${Math.floor(status.gateway.uptimeMs / 1000)}s`), item("dataPath", status.gateway.dataPath)]),
      panel("SSE", [item("连接客户端", status.sse.connectedClients), item("当前 seq", status.sse.currentSeq), item("缓冲上限", status.sse.bufferSize)]),
      panel("File store", [item("类型", status.store.kind), ...Object.entries(status.store.collections).map(([key, value]) => item(key, value))]),
      panel("Memory vault", [item("路径", status.memory.vaultPath), item("可用", status.memory.vaultExists ? "是" : "否"), item("Memory", status.memory.memoryCount), item("未归属", status.memory.legacyUnscopedCount)]),
      panel("Agent daemon", [item("联邦形态", status.agents.federation === "disabled" ? "Phase 5.5 未启用" : status.agents.federation), item("在线 Account", status.agents.onlineAccounts)]),
      panel("最近错误", status.recentErrors.length ? status.recentErrors.map((error) => item(`${error.scope} · ${error.code}`, error.message)) : [item("状态", "无")]),
    );
  }
  async function refresh() {
    try {
      const response = await client.get();
      if (!disposed) { render(response.status); notice.textContent = `最近更新：${new Date().toLocaleTimeString()}`; notice.dataset.tone = "success"; }
    } catch (err) {
      if (!disposed) { notice.textContent = `gateway 不可达：${err.message}（5 秒后重试）`; notice.dataset.tone = "danger"; }
    }
  }
  const poller = createPagePoller({ task: refresh, intervalMs: 5000 });
  await poller.start();
  return () => {
    disposed = true;
    poller.stop();
    root.replaceChildren();
  };
}
