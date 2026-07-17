import { createHttpClient } from "../api/http-client.js";
import { createSpacesClient } from "../api/spaces-client.js";

function formatTime(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "时间未知";
}

function historyItem(item, accounts) {
  const row = document.createElement("article");
  row.className = "vera-management-card";
  const label = document.createElement("strong");
  if (item.itemType === "message") {
    label.textContent = item.author?.type === "account"
      ? item.author.accountNameSnapshot ?? accounts.get(item.author.accountId) ?? "Account"
      : "用户";
  } else if (item.itemType === "activity") {
    label.textContent = `Activity · ${item.label ?? item.phase ?? "过程"}`;
  } else {
    label.textContent = "Approval";
  }
  const content = document.createElement("p");
  content.textContent = item.content ?? item.detail ?? item.prompt ?? "";
  const time = document.createElement("small");
  time.textContent = formatTime(item.createdAt);
  row.append(label, content, time);
  return row;
}

function runItem(run, accounts) {
  const row = document.createElement("article");
  row.className = "vera-management-card";
  const label = document.createElement("strong");
  label.textContent = `${accounts.get(run.accountId) ?? "Account"} · Run`;
  const content = document.createElement("p");
  content.textContent = run.error?.message ? `${run.status} · ${run.error.message}` : run.status;
  const time = document.createElement("small");
  time.textContent = formatTime(run.endedAt ?? run.createdAt);
  row.append(label, content, time);
  return row;
}

export async function mountSpaceHistoryView({
  root, platform, runtime, spaceId, spaceSessionId, shell,
} = {}) {
  let mounted = true;
  root.dataset.routeScope = "management";
  const client = createSpacesClient(createHttpClient(platform));
  const bootstrap = runtime.getBootstrap();
  const space = bootstrap.spaces.find((item) => item.id === spaceId);
  const accounts = new Map(bootstrap.accounts.map((account) => [account.id, account.name]));
  shell?.setManagementHeader({
    title: spaceSessionId ? "历史对话" : "对话历史",
    backHref: spaceSessionId
      ? `#/spaces/${encodeURIComponent(spaceId)}/history`
      : `#/spaces/${encodeURIComponent(spaceId)}/settings`,
    backLabel: "返回",
  });

  const status = document.createElement("p");
  status.className = "vera-management-notice";
  status.setAttribute("role", "status");
  status.textContent = "加载中…";
  root.appendChild(status);

  try {
    if (!spaceSessionId) {
      const response = await client.listSessions(spaceId, { status: "archived" });
      if (!mounted) return () => {};
      root.replaceChildren();
      if (response.sessions.length === 0) {
        status.textContent = "还没有历史对话。";
        root.appendChild(status);
      } else {
        for (const session of response.sessions) {
          const link = document.createElement("a");
          link.className = "vera-management-card";
          link.href = `#/spaces/${encodeURIComponent(spaceId)}/history/${encodeURIComponent(session.id)}`;
          link.textContent = `${formatTime(session.createdAt)} 开始 · ${formatTime(session.archivedAt)} 归档`;
          root.appendChild(link);
        }
      }
    } else {
      const response = await client.fetchSessionTimeline(spaceId, spaceSessionId, { limit: 200 });
      if (!mounted) return () => {};
      root.replaceChildren();
      if (response.items.length === 0) {
        status.textContent = "这个历史窗口没有时间线内容。";
        root.appendChild(status);
      } else {
        for (const item of [...response.items].reverse()) root.appendChild(historyItem(item, accounts));
        for (const run of response.runs ?? []) root.appendChild(runItem(run, accounts));
      }
    }
  } catch (error) {
    status.textContent = `历史加载失败：${error.message}`;
  }

  return () => {
    mounted = false;
    root.replaceChildren();
  };
}
