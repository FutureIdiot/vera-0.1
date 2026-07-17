import { createHttpClient } from "../api/http-client.js";
import { createAccountsClient } from "../api/accounts-client.js";
import { createNotice, field, input, setBusy } from "../components/management-ui.js";

export function mountAccountListView({ root, platform, runtime, shell } = {}) {
  root.dataset.routeScope = "management";
  const accountsClient = createAccountsClient(createHttpClient(platform));
  let agents = [...runtime.getBootstrap().agents];
  let accounts = [...runtime.getBootstrap().accounts];
  shell?.setManagementHeader({ title: "Account", backHref: "#/settings", backLabel: "返回" });
  const content = document.createElement("div");
  content.className = "vera-management-content";
  const toolbar = document.createElement("form");
  toolbar.className = "vera-inline-form";
  const name = input({ placeholder: "Account 名称" });
  const create = document.createElement("button");
  create.type = "submit";
  create.className = "vera-primary-button";
  create.textContent = "新建 Account";
  const feedback = createNotice("");
  toolbar.append(field("新建 Account", name), create);
  const list = document.createElement("div");
  list.className = "vera-account-list";
  content.append(toolbar, feedback, list);
  root.appendChild(content);

  function render() {
    list.replaceChildren();
    if (accounts.length === 0) {
      list.appendChild(createNotice("还没有 Account。新建后会生成一次性接入 Key。"));
      return;
    }
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    for (const account of accounts) {
      const owner = account.ownerAgentId ? agentById.get(account.ownerAgentId) : null;
      const active = account.activeAgentId ? agentById.get(account.activeAgentId) : null;
      const row = document.createElement("a");
      row.className = "vera-account-row";
      row.href = `#/settings/accounts/${encodeURIComponent(account.id)}`;
      const identity = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = account.name;
      const summary = document.createElement("small");
      const ownership = owner ? `所属 ${owner.name}` : "等待所属 Agent 接入";
      const presence = account.presence === "online"
        ? `在线${active ? ` · 当前 ${active.name}` : ""}`
        : "离线";
      summary.textContent = `${ownership} · ${presence}`;
      identity.append(title, summary);
      const arrow = document.createElement("span");
      arrow.textContent = "›";
      row.append(identity, arrow);
      list.appendChild(row);
    }
  }
  toolbar.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!name.value.trim()) return;
    setBusy(create, true, "创建中…");
    try {
      const result = await accountsClient.create({ name: name.value.trim() });
      accounts = [...accounts, result.account];
      runtime.mergeAccount(result.account);
      name.value = "";
      feedback.textContent = result.accessKey
        ? `Account 已创建。一次性接入 Key：${result.accessKey}`
        : "Account 已创建";
      feedback.dataset.tone = "success";
      render();
    } catch (err) { feedback.textContent = err.message; feedback.dataset.tone = "danger"; }
    finally { setBusy(create, false); }
  });
  const unsubscribe = runtime.subscribe((envelope) => {
    if (envelope.type === "runtime.reset") {
      agents = [...envelope.data.bootstrap.agents];
      accounts = [...envelope.data.bootstrap.accounts];
      render();
    } else if (envelope.type === "agent.updated" && envelope.data?.agent) {
      agents = agents.map((agent) => agent.id === envelope.data.agent.id ? envelope.data.agent : agent);
      render();
    } else if (envelope.type === "account.upserted" && envelope.data?.account) {
      const account = envelope.data.account;
      accounts = accounts.some((item) => item.id === account.id) ? accounts.map((item) => item.id === account.id ? account : item) : [...accounts, account];
      render();
    } else if (envelope.type === "account.presence.updated") {
      accounts = runtime.getBootstrap().accounts;
      render();
    }
  });
  render();
  return () => { unsubscribe(); root.replaceChildren(); };
}
