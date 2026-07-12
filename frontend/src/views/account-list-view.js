import { createHttpClient } from "../api/http-client.js";
import { createAgentsClient } from "../api/agents-client.js";
import { createNotice, field, input, setBusy } from "../components/management-ui.js";

export function mountAccountListView({ root, platform, runtime, shell } = {}) {
  root.dataset.routeScope = "management";
  const agentsClient = createAgentsClient(createHttpClient(platform));
  let agents = [...runtime.getBootstrap().agents];
  let accounts = [...runtime.getBootstrap().accounts];
  shell?.setManagementHeader({ title: "Account", backHref: "#/settings", backLabel: "返回" });
  const content = document.createElement("div");
  content.className = "vera-management-content";
  const toolbar = document.createElement("form");
  toolbar.className = "vera-inline-form";
  const name = input({ placeholder: "新 Agent 名称" });
  const create = document.createElement("button");
  create.type = "submit";
  create.className = "vera-primary-button";
  create.textContent = "新建 Agent";
  const feedback = createNotice("");
  toolbar.append(field("新建身份", name), create);
  const list = document.createElement("div");
  list.className = "vera-account-list";
  content.append(toolbar, feedback, list);
  root.appendChild(content);

  function render() {
    list.replaceChildren();
    if (agents.length === 0) {
      list.appendChild(createNotice("还没有 Agent，新建一个后会自动建立第一条 Account 连接。"));
      return;
    }
    for (const agent of agents) {
      const owned = accounts.filter((account) => account.owningAgentId === agent.id);
      const row = document.createElement("a");
      row.className = "vera-account-row";
      row.href = `#/settings/accounts/${encodeURIComponent(agent.id)}`;
      const identity = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = agent.name;
      const summary = document.createElement("small");
      const online = owned.filter((account) => account.presence === "online").length;
      summary.textContent = `${owned.length} 条连接 · ${online ? `${online} 在线` : "离线"} · Memory 按需查看`;
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
      const result = await agentsClient.create({ name: name.value.trim() });
      agents = [...agents, result.agent];
      accounts = [...accounts, result.account];
      runtime.mergeAgent(result.agent);
      runtime.mergeAccount(result.account);
      name.value = "";
      feedback.textContent = "Agent 与第一条 Account 已创建";
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
