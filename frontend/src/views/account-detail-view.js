import { createHttpClient } from "../api/http-client.js";
import { createAccountsClient } from "../api/accounts-client.js";
import { createNotice, field, input, setBusy } from "../components/management-ui.js";

function infoRow(label, value) {
  const row = document.createElement("div");
  row.className = "vera-agent-info-row";
  const key = document.createElement("span");
  key.className = "vera-agent-info-row__label";
  key.textContent = label;
  const content = document.createElement("span");
  content.className = "vera-agent-info-row__value";
  if (value instanceof Node) content.appendChild(value);
  else content.textContent = value ?? "—";
  row.append(key, content);
  return row;
}

function agentLink(agent, fallback = "—") {
  if (!agent) return fallback;
  const link = document.createElement("a");
  link.href = `#/agents/${encodeURIComponent(agent.id)}`;
  link.textContent = agent.name;
  return link;
}

function formatTime(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "—";
}

export async function mountAccountDetailView({ root, platform, runtime, accountId, shell } = {}) {
  root.dataset.routeScope = "management";
  const accountsClient = createAccountsClient(createHttpClient(platform));
  let account = runtime.getBootstrap().accounts.find((item) => item.id === accountId) ?? null;
  let detail = null;
  let disposed = false;

  shell?.setManagementHeader({
    title: account?.name ?? "Account",
    backHref: "#/settings/accounts",
    backLabel: "返回",
  });

  const content = document.createElement("div");
  content.className = "vera-management-content";
  const feedback = createNotice("正在读取 Account 信息…");

  const identity = document.createElement("section");
  identity.className = "vera-management-section";
  const identityTitle = document.createElement("h2");
  identityTitle.textContent = "Account 身份";
  const renameForm = document.createElement("form");
  renameForm.className = "vera-inline-form";
  const accountName = input({ value: account?.name, placeholder: "Account 名称" });
  const rename = document.createElement("button");
  rename.type = "submit";
  rename.className = "vera-secondary-button";
  rename.textContent = "修改名称";
  renameForm.append(field("名称", accountName), rename);
  const identityFacts = document.createElement("div");
  identityFacts.className = "vera-agent-info-panel";
  identity.append(identityTitle, renameForm, identityFacts);

  const access = document.createElement("section");
  access.className = "vera-management-section";
  const accessTitle = document.createElement("h2");
  accessTitle.textContent = "接入 Key";
  const accessStatus = createNotice("");
  const accessActions = document.createElement("div");
  accessActions.className = "vera-form-actions";
  const rotate = document.createElement("button");
  rotate.type = "button";
  rotate.className = "vera-secondary-button";
  rotate.textContent = "生成 / 轮换 Key";
  const revoke = document.createElement("button");
  revoke.type = "button";
  revoke.className = "vera-danger-button";
  revoke.textContent = "撤销 Key";
  accessActions.append(rotate, revoke);
  access.append(accessTitle, accessStatus, accessActions);

  const workspace = document.createElement("section");
  workspace.className = "vera-management-section";
  const workspaceTitle = document.createElement("h2");
  workspaceTitle.textContent = "Workspace";
  const workspaceFacts = document.createElement("div");
  workspaceFacts.className = "vera-agent-info-panel";
  workspace.append(workspaceTitle, workspaceFacts);

  const audit = document.createElement("section");
  audit.className = "vera-management-section";
  const auditTitle = document.createElement("h2");
  auditTitle.textContent = "最近登录";
  const auditList = document.createElement("div");
  auditList.className = "vera-account-grid";
  audit.append(auditTitle, auditList);

  content.append(feedback, identity, access, workspace, audit);
  root.appendChild(content);

  function findAgent(id) {
    return id ? runtime.getBootstrap().agents.find((item) => item.id === id) ?? null : null;
  }

  function render() {
    if (!account) {
      content.replaceChildren(createNotice("Account 不存在", "danger"));
      return;
    }
    accountName.value = account.name ?? "";
    shell?.setManagementHeader({ title: account.name, backHref: "#/settings/accounts", backLabel: "返回" });
    const owner = detail?.ownerAgent ?? findAgent(account.ownerAgentId);
    const active = detail?.activeAgent ?? findAgent(account.activeAgentId);
    identityFacts.replaceChildren(
      infoRow("所属 Agent", agentLink(owner, account.ownerAgentId ? "未知 Agent" : "等待首次接入")),
      infoRow("当前 Agent", agentLink(active, account.presence === "online" ? "在线，身份待同步" : "—")),
      infoRow("状态", account.presence ?? "offline"),
      infoRow("最近在线", formatTime(account.lastSeenAt)),
    );
    accessStatus.textContent = `状态：${account.accessKeyState ?? "未知"} · 版本：${account.accessKeyVersion ?? "—"}`;
    revoke.disabled = account.accessKeyState === "revoked";
    const workspaceValue = detail?.workspace ?? account.workspace ?? null;
    workspaceFacts.replaceChildren(
      infoRow("状态", workspaceValue?.status ?? "尚未绑定"),
      infoRow("宿主", workspaceValue?.hostId ?? "—"),
      infoRow("最近校验", formatTime(workspaceValue?.lastValidatedAt)),
    );
    const entries = detail?.recentLogins ?? detail?.loginAudit ?? [];
    auditList.replaceChildren();
    if (!entries.length) auditList.appendChild(createNotice("还没有登录记录。"));
    for (const entry of entries) {
      const card = document.createElement("article");
      card.className = "vera-management-card";
      const title = document.createElement("strong");
      title.textContent = findAgent(entry.agentId)?.name ?? entry.agentId ?? "Agent";
      const summary = document.createElement("small");
      summary.textContent = `${entry.status ?? entry.result ?? "记录"} · ${formatTime(entry.createdAt ?? entry.at)}`;
      card.append(title, summary);
      auditList.appendChild(card);
    }
  }

  async function load() {
    try {
      const response = await accountsClient.get(accountId);
      if (disposed) return;
      detail = response;
      account = response.account ?? account;
      if (account) runtime.mergeAccount(account);
      feedback.textContent = "Account 身份、Workspace 与运行时配置彼此独立。";
      feedback.dataset.tone = "";
      render();
    } catch (error) {
      if (disposed) return;
      if (account && error.status === 404) account = null;
      feedback.textContent = error.message;
      feedback.dataset.tone = "danger";
      render();
    }
  }

  renameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!account || !accountName.value.trim()) return;
    setBusy(rename, true, "保存中…");
    try {
      account = (await accountsClient.update(account.id, { name: accountName.value.trim() })).account;
      runtime.mergeAccount(account);
      feedback.textContent = "Account 名称已保存";
      feedback.dataset.tone = "success";
      render();
    } catch (error) {
      feedback.textContent = error.message;
      feedback.dataset.tone = "danger";
    } finally {
      setBusy(rename, false);
    }
  });

  rotate.addEventListener("click", async () => {
    if (!account) return;
    setBusy(rotate, true, "生成中…");
    try {
      const response = await accountsClient.rotateAccessKey(account.id);
      account = response.account ?? account;
      runtime.mergeAccount(account);
      feedback.textContent = `一次性接入 Key：${response.accessKey}`;
      feedback.dataset.tone = "success";
      render();
    } catch (error) {
      feedback.textContent = error.message;
      feedback.dataset.tone = "danger";
    } finally {
      setBusy(rotate, false);
    }
  });

  revoke.addEventListener("click", async () => {
    if (!account || !window.confirm(`撤销“${account.name}”的接入 Key？`)) return;
    setBusy(revoke, true, "撤销中…");
    try {
      const response = await accountsClient.revokeAccessKey(account.id);
      account = response?.account ?? { ...account, accessKeyState: "revoked" };
      runtime.mergeAccount(account);
      feedback.textContent = "接入 Key 已撤销";
      feedback.dataset.tone = "success";
      render();
    } catch (error) {
      feedback.textContent = error.message;
      feedback.dataset.tone = "danger";
    } finally {
      setBusy(revoke, false);
    }
  });

  render();
  await load();
  const unsubscribe = runtime.subscribe((envelope) => {
    if (envelope.type === "runtime.reset") {
      account = envelope.data.bootstrap.accounts.find((item) => item.id === accountId) ?? null;
      void load();
      return;
    }
    if (envelope.type === "account.upserted" && envelope.data?.account?.id === accountId) {
      account = envelope.data.account;
      render();
    }
    if (envelope.type === "account.presence.updated" && envelope.data?.accountId === accountId) {
      account = runtime.getBootstrap().accounts.find((item) => item.id === accountId) ?? account;
      render();
    }
  });
  return () => {
    disposed = true;
    unsubscribe();
    root.replaceChildren();
  };
}
