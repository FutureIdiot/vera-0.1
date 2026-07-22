import { createHttpClient } from "../api/http-client.js";
import { createAccountsClient } from "../api/accounts-client.js";
import { createAccountModelControl } from "../components/account-model-control.js";
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

  const spaces = document.createElement("section");
  spaces.className = "vera-management-section";
  const spacesTitle = document.createElement("h2");
  spacesTitle.textContent = "参与的 Space";
  const spacesList = document.createElement("div");
  spacesList.className = "vera-account-grid";
  spaces.append(spacesTitle, spacesList);

  const audit = document.createElement("section");
  audit.className = "vera-management-section";
  const auditTitle = document.createElement("h2");
  auditTitle.textContent = "最近登录";
  const auditList = document.createElement("div");
  auditList.className = "vera-account-grid";
  audit.append(auditTitle, auditList);

  content.append(feedback, identity, access, workspace, spaces, audit);
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
    const owner = detail ? detail.ownerAgent ?? null : findAgent(account.ownerAgentId);
    identityFacts.replaceChildren(
      infoRow("所属 Agent", agentLink(owner, account.ownerAgentId ? "未知 Agent" : "等待首次接入")),
      infoRow("模型", createAccountModelControl({
        account,
        ownerAgent: owner,
        modelOptions: detail?.modelOptions,
        updateModel: (body) => accountsClient.updateModel(account.id, body),
        onSaved(nextAccount) {
          account = nextAccount;
          detail = { ...detail, account };
          runtime.mergeAccount(account);
          feedback.textContent = "Model 已保存；后续聊天将使用新模型，聊天上下文已轮换。";
          feedback.dataset.tone = "success";
          render();
        },
        onError(error) {
          feedback.textContent = error.message;
          feedback.dataset.tone = "danger";
        },
      })),
      infoRow("状态", account.presence ?? "offline"),
      infoRow("最近在线", formatTime(account.lastSeenAt)),
    );
    accessStatus.textContent = `状态：${account.accessKeyState ?? "未知"} · 版本：${account.accessKeyVersion ?? "—"}`;
    revoke.disabled = account.accessKeyState === "revoked";
    const workspaceValue = detail?.account?.workspace ?? account.workspace ?? null;
    workspaceFacts.replaceChildren(
      infoRow("状态", workspaceValue?.status ?? "尚未绑定"),
      infoRow("宿主", workspaceValue?.hostId ?? "—"),
      infoRow("最近校验", formatTime(workspaceValue?.lastValidatedAt)),
    );
    const activeSpaces = (runtime.getBootstrap().spaces ?? []).filter((space) =>
      space.archivedAt == null
      && Array.isArray(space.seats)
      && space.seats.some((seat) => seat.accountId === account.id));
    spacesList.replaceChildren();
    if (!activeSpaces.length) spacesList.appendChild(createNotice("当前没有参与 active Space。"));
    for (const space of activeSpaces) {
      const seat = space.seats.find((candidate) => candidate.accountId === account.id);
      const card = document.createElement("article");
      card.className = "vera-management-card";
      const actions = document.createElement("div");
      actions.className = "vera-form-actions";
      const open = document.createElement("a");
      open.className = "vera-text-button";
      open.href = `#/spaces/${encodeURIComponent(space.id)}`;
      open.textContent = "进入 Space";
      const settings = document.createElement("a");
      settings.className = "vera-text-button";
      settings.href = `#/spaces/${encodeURIComponent(space.id)}/settings`;
      settings.textContent = "Space 设置";
      actions.append(open, settings);
      card.append(
        infoRow("名称", space.name ?? "未命名 Space"),
        infoRow("主题", space.topic || "—"),
        infoRow("响应模式", seat?.responseMode ?? "default"),
        actions,
      );
      spacesList.appendChild(card);
    }
    const entries = Array.isArray(detail?.recentLogins) ? detail.recentLogins : [];
    auditList.replaceChildren();
    if (!entries.length) auditList.appendChild(createNotice("还没有登录记录。"));
    for (const entry of entries) {
      const card = document.createElement("article");
      card.className = "vera-management-card";
      card.append(
        infoRow("事件", entry.event ?? "—"),
        infoRow("结果", entry.result ?? "—"),
        infoRow("原因", entry.reasonCode ?? "—"),
        infoRow("Agent", agentLink(findAgent(entry.agentId), entry.agentId ?? "—")),
        infoRow("时间", formatTime(entry.createdAt)),
      );
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
      await load();
      if (disposed) return;
      feedback.textContent = `一次性接入 Key：${response.accessKey}`;
      feedback.dataset.tone = "success";
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
      await load();
      if (disposed) return;
      feedback.textContent = "接入 Key 已撤销";
      feedback.dataset.tone = "success";
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
      void load();
    }
  });
  return () => {
    disposed = true;
    unsubscribe();
    root.replaceChildren();
  };
}
