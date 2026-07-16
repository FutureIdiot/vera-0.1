import { createHttpClient } from "../api/http-client.js";
import { createAccountsClient } from "../api/accounts-client.js";
import { createAgentsClient } from "../api/agents-client.js";
import { createNotice, field, input, select, setBusy } from "../components/management-ui.js";

function accountEditor(account, { onSave, onDelete }) {
  const form = document.createElement("form");
  form.className = "vera-account-card";
  const name = input({ value: account.name });
  const kind = select(account.kind ?? "", [["", "未指定"], ["cli", "CLI"], ["api", "API"]]);
  const provider = input({ value: account.provider, placeholder: "例如 opencode / openai" });
  const model = input({ value: account.model, placeholder: "模型名" });
  const secretRef = input({
    value: account.connection?.secretRef,
    placeholder: "~/.vera/secrets.json 中的引用名",
  });
  const secretField = field("Secret 引用名", secretRef, "这里只保存引用名，不读取或返回密钥明文");
  const capability = createNotice(
    account.runtimeCapabilities === null ? "未连接，能力未知" : "已连接，能力快照可用",
  );
  const actions = document.createElement("div");
  actions.className = "vera-form-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "vera-primary-button";
  save.textContent = "保存连接";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "vera-danger-button";
  remove.textContent = "删除这条连接";
  actions.append(save, remove);
  form.append(
    field("连接名称", name),
    field("类型", kind),
    field("供应商", provider),
    field("模型", model),
    secretField,
    capability,
    actions,
  );

  function syncConnectionFields() {
    secretField.hidden = kind.value !== "api";
  }

  kind.addEventListener("change", syncConnectionFields);
  syncConnectionFields();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(save, true, "保存中…");
    const connection = kind.value === "api"
      ? { ...(account.connection ?? {}), secretRef: secretRef.value.trim() || null }
      : account.connection ?? {};
    try {
      await onSave(account.id, {
        name: name.value,
        kind: kind.value || null,
        provider: provider.value || null,
        model: model.value,
        connection,
      });
    } finally {
      setBusy(save, false);
    }
  });

  remove.addEventListener("click", async () => {
    if (!window.confirm(`删除连接“${account.name}”？这不会删除 Agent 身份。`)) return;
    setBusy(remove, true, "删除中…");
    try {
      await onDelete(account.id);
    } finally {
      setBusy(remove, false);
    }
  });
  return form;
}

export async function mountAccountDetailView({ root, platform, runtime, agentId, shell } = {}) {
  root.dataset.routeScope = "management";
  const http = createHttpClient(platform);
  const accountsClient = createAccountsClient(http);
  const agentsClient = createAgentsClient(http);
  let agent = runtime.getBootstrap().agents.find((item) => item.id === agentId);
  let accounts = [];
  let disposed = false;

  shell?.setManagementHeader({
    title: agent?.name ?? "Account",
    backHref: "#/settings/accounts",
    backLabel: "返回",
  });
  if (!agent) {
    root.appendChild(createNotice("Agent 不存在", "danger"));
    return () => root.replaceChildren();
  }

  const content = document.createElement("div");
  content.className = "vera-management-content";
  const feedback = createNotice("正在读取系统账户信息…");

  const identity = document.createElement("section");
  identity.className = "vera-management-section";
  const identityTitle = document.createElement("h2");
  identityTitle.textContent = "Agent 系统身份";
  const renameForm = document.createElement("form");
  renameForm.className = "vera-inline-form";
  const agentName = input({ value: agent.name });
  const rename = document.createElement("button");
  rename.type = "submit";
  rename.className = "vera-secondary-button";
  rename.textContent = "修改名称";
  renameForm.append(field("名称", agentName), rename);
  const deleteAgent = document.createElement("button");
  deleteAgent.type = "button";
  deleteAgent.className = "vera-danger-button";
  deleteAgent.textContent = "删除 Agent 身份";
  identity.append(identityTitle, renameForm, deleteAgent);

  const connections = document.createElement("section");
  connections.className = "vera-management-section";
  const connectionsTitle = document.createElement("h2");
  connectionsTitle.textContent = "Account 连接";
  const connectionList = document.createElement("div");
  connectionList.className = "vera-account-grid";
  const addForm = document.createElement("form");
  addForm.className = "vera-inline-form";
  const newName = input({ placeholder: "新连接名称" });
  const add = document.createElement("button");
  add.type = "submit";
  add.className = "vera-secondary-button";
  add.textContent = "添加连接";
  addForm.append(field("新的 Account", newName), add);
  connections.append(connectionsTitle, connectionList, addForm);
  content.append(feedback, identity, connections);
  root.appendChild(content);

  function renderConnections() {
    connectionList.replaceChildren();
    if (!accounts.length) connectionList.appendChild(createNotice("这条 Agent 还没有连接。"));
    for (const account of accounts) {
      connectionList.appendChild(accountEditor(account, {
        onSave: async (id, patch) => {
          try {
            const updated = (await accountsClient.update(id, patch)).account;
            accounts = accounts.map((item) => item.id === id ? updated : item);
            runtime.mergeAccount(updated);
            feedback.textContent = "连接已保存";
            feedback.dataset.tone = "success";
            renderConnections();
          } catch (err) {
            feedback.textContent = err.message;
            feedback.dataset.tone = "danger";
          }
        },
        onDelete: async (id) => {
          try {
            await accountsClient.remove(id);
            accounts = accounts.filter((item) => item.id !== id);
            runtime.removeAccount(id);
            feedback.textContent = "连接已删除，Agent 身份保留";
            renderConnections();
          } catch (err) {
            feedback.textContent = err.message;
            feedback.dataset.tone = "danger";
          }
        },
      }));
    }
  }

  renameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(rename, true);
    try {
      agent = (await agentsClient.update(agentId, { name: agentName.value.trim() })).agent;
      runtime.mergeAgent(agent);
      shell?.setManagementHeader({
        title: agent.name,
        backHref: "#/settings/accounts",
        backLabel: "返回",
      });
      feedback.textContent = "Agent 名称已保存";
      feedback.dataset.tone = "success";
    } catch (err) {
      feedback.textContent = err.message;
      feedback.dataset.tone = "danger";
    } finally {
      setBusy(rename, false);
    }
  });

  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(add, true, "添加中…");
    try {
      const result = await accountsClient.create(agentId, { name: newName.value.trim() || undefined });
      accounts = [...accounts, result.account];
      runtime.mergeAccount(result.account);
      newName.value = "";
      feedback.textContent = "已添加连接";
      feedback.dataset.tone = "success";
      renderConnections();
    } catch (err) {
      feedback.textContent = err.message;
      feedback.dataset.tone = "danger";
    } finally {
      setBusy(add, false);
    }
  });

  deleteAgent.addEventListener("click", async () => {
    if (!window.confirm(`删除 Agent“${agent.name}”及其自有连接？`)) return;
    setBusy(deleteAgent, true, "删除中…");
    try {
      await agentsClient.remove(agentId);
      runtime.removeAgent(agentId);
      window.location.hash = "#/settings/accounts";
    } catch (err) {
      feedback.textContent = err.message;
      feedback.dataset.tone = "danger";
      setBusy(deleteAgent, false);
    }
  });

  try {
    accounts = (await accountsClient.list(agentId)).accounts;
    if (!disposed) {
      feedback.textContent = "此页只管理 Vera 系统身份与 Account 连接。";
      renderConnections();
    }
  } catch (err) {
    feedback.textContent = err.message;
    feedback.dataset.tone = "danger";
  }

  const unsubscribe = runtime.subscribe((envelope) => {
    if (envelope.type !== "account.presence.updated" && envelope.type !== "account.upserted") return;
    void accountsClient.list(agentId).then((response) => {
      if (!disposed) {
        accounts = response.accounts;
        renderConnections();
      }
    });
  });
  return () => {
    disposed = true;
    unsubscribe();
    root.replaceChildren();
  };
}
