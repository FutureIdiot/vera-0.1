import { createHttpClient } from "../api/http-client.js";
import { createMemoryClient } from "../api/memory-client.js";
import { createAgentsClient } from "../api/agents-client.js";
import { createNotice, setBusy } from "../components/management-ui.js";

export async function mountAgentMemoryConfigView({ root, platform, runtime, agentId, shell } = {}) {
  root.dataset.routeScope = "management";
  const agent = runtime.getBootstrap().agents.find((item) => item.id === agentId);
  const back = `#/settings/accounts/${encodeURIComponent(agentId)}/data`;
  shell?.setManagementHeader({ title: `${agent?.name ?? "Agent"} Memory`, backHref: back, backLabel: "返回" });

  if (!agent) {
    root.appendChild(createNotice("Agent 不存在", "danger"));
    return () => root.replaceChildren();
  }

  const http = createHttpClient(platform);
  const memoryClient = createMemoryClient(http);
  const agentsClient = createAgentsClient(http);

  let disposed = false;
  let loading = true;
  let error = null;
  let config = null;
  let status = null;
  let options = null;

  const content = document.createElement("div");
  content.className = "vera-management-content";

  const feedback = createNotice("");
  feedback.hidden = true;

  // Provider section
  const providerSection = document.createElement("section");
  providerSection.className = "vera-management-section";
  const providerTitle = document.createElement("h2");
  providerTitle.textContent = "Memory 结构";
  providerSection.appendChild(providerTitle);

  // Status section
  const statusSection = document.createElement("section");
  statusSection.className = "vera-management-section";
  const statusTitle = document.createElement("h2");
  statusTitle.textContent = "状态";
  statusSection.appendChild(statusTitle);

  // Digest section
  const digestSection = document.createElement("section");
  digestSection.className = "vera-management-section";
  const digestTitle = document.createElement("h2");
  digestTitle.textContent = "Digest";
  digestSection.appendChild(digestTitle);

  // Dream section
  const dreamSection = document.createElement("section");
  dreamSection.className = "vera-management-section";
  const dreamTitle = document.createElement("h2");
  dreamTitle.textContent = "Dream";
  dreamSection.appendChild(dreamTitle);

  // Actions
  const actionsSection = document.createElement("div");
  actionsSection.className = "vera-form-actions";
  const digestBtn = document.createElement("button");
  digestBtn.type = "button";
  digestBtn.className = "vera-secondary-button";
  digestBtn.textContent = "手动 Digest";
  const dreamBtn = document.createElement("button");
  dreamBtn.type = "button";
  dreamBtn.className = "vera-secondary-button";
  dreamBtn.textContent = "立即 Dream";
  const libraryLink = document.createElement("a");
  libraryLink.className = "vera-secondary-button vera-button-link";
  libraryLink.href = `#/settings/accounts/${encodeURIComponent(agentId)}/data/memory/library`;
  libraryLink.textContent = "长期记忆管理";
  actionsSection.append(digestBtn, dreamBtn, libraryLink);

  content.append(feedback, providerSection, statusSection, digestSection, dreamSection, actionsSection);
  root.appendChild(content);

  function renderProvider() {
    providerSection.replaceChildren(providerTitle);
    const provider = config?.provider ?? { providerId: "vera.markdown" };
    const name = provider.providerId === "vera.markdown" ? "Vera（兼容 Obsidian）" : provider.providerId;
    const p = document.createElement("p");
    p.className = "vera-management-notice";
    p.textContent = `当前 Provider：${name}`;
    providerSection.appendChild(p);
  }

  function renderStatus() {
    statusSection.replaceChildren(statusTitle);
    if (!status) {
      statusSection.appendChild(createNotice("状态不可用"));
      return;
    }

    const longTerm = status.longTerm;
    if (longTerm) {
      const p = document.createElement("p");
      p.className = "vera-management-notice";
      p.textContent = `长期记忆：${longTerm.activeCount ?? 0} 条活跃${longTerm.archivedCount ? `、${longTerm.archivedCount} 条已归档` : ""}`;
      statusSection.appendChild(p);
    }

    const pending = status.pendingContext;
    if (pending) {
      const p = document.createElement("p");
      p.className = "vera-management-notice";
      p.textContent = `待整理：${pending.messageCount ?? 0} 条消息 · ${pending.charCount ?? 0} 字符`;
      statusSection.appendChild(p);
    }
  }

  function renderDigest() {
    digestSection.replaceChildren(digestTitle);
    const digest = config?.digest;
    if (!digest) {
      digestSection.appendChild(createNotice("未配置"));
      return;
    }

    const modeText = digest.trigger?.mode === "manual" ? "手动" : digest.trigger?.mode === "realtime" ? "实时" : digest.trigger?.mode === "scheduled" ? "定时" : "—";
    const executor = digest.executorAgentId ?? "自身";
    const model = digest.modelMode === "inherit" ? "继承聊天模型" : digest.model ?? "—";

    const p = document.createElement("p");
    p.className = "vera-management-notice";
    p.textContent = `策略：${modeText} · 执行者：${executor} · 模型：${model}`;
    digestSection.appendChild(p);

    const digestStatus = status?.digest;
    if (digestStatus?.lastJob) {
      const s = document.createElement("p");
      s.className = "vera-management-notice";
      s.textContent = `上次：${digestStatus.lastJob.status ?? "—"}`;
      digestSection.appendChild(s);
    }
  }

  function renderDream() {
    dreamSection.replaceChildren(dreamTitle);
    const dream = config?.dream;
    if (!dream) {
      dreamSection.appendChild(createNotice("未配置"));
      return;
    }

    const modeText = dream.schedule?.mode === "manual" ? "手动" : dream.schedule?.mode === "daily" ? "每天" : dream.schedule?.mode === "weekly" ? "每周" : dream.schedule?.mode === "custom" ? "自定义" : "—";
    const executor = dream.executorAgentId ?? "自身";
    const model = dream.modelMode === "inherit" ? "继承聊天模型" : dream.model ?? "—";

    const p = document.createElement("p");
    p.className = "vera-management-notice";
    p.textContent = `调度：${modeText} · 执行者：${executor} · 模型：${model}`;
    dreamSection.appendChild(p);

    const dreamStatus = status?.dream;
    if (dreamStatus?.lastJob) {
      const s = document.createElement("p");
      s.className = "vera-management-notice";
      s.textContent = `上次：${dreamStatus.lastJob.status ?? "—"}`;
      dreamSection.appendChild(s);
    }
  }

  function render() {
    if (loading) {
      content.replaceChildren(createNotice("正在读取 Memory 配置…"));
      return;
    }
    if (error) {
      content.replaceChildren(createNotice(error, "danger"));
      return;
    }

    // Ensure sections are in DOM
    if (!content.contains(feedback)) content.prepend(feedback);
    if (!content.contains(providerSection)) content.insertBefore(providerSection, statusSection);
    if (!content.contains(statusSection)) content.insertBefore(statusSection, digestSection);
    if (!content.contains(digestSection)) content.insertBefore(digestSection, dreamSection);
    if (!content.contains(dreamSection)) content.insertBefore(dreamSection, actionsSection);
    if (!content.contains(actionsSection)) content.appendChild(actionsSection);

    renderProvider();
    renderStatus();
    renderDigest();
    renderDream();
  }

  async function load() {
    loading = true;
    error = null;
    render();

    try {
      const [configRes, statusRes] = await Promise.all([
        memoryClient.getConfig(agentId).catch(() => null),
        memoryClient.getStatus(agentId).catch(() => null),
      ]);
      if (disposed) return;
      config = configRes?.config ?? null;
      status = statusRes ?? null;
    } catch (err) {
      if (!disposed) error = err.message;
    } finally {
      if (!disposed) {
        loading = false;
        render();
      }
    }
  }

  digestBtn.addEventListener("click", async () => {
    setBusy(digestBtn, true, "触发中…");
    try {
      await memoryClient.enqueueDigest(agentId, { mode: "incremental" });
      feedback.textContent = "Digest 任务已加入队列";
      feedback.dataset.tone = "success";
      feedback.hidden = false;
      await load();
    } catch (err) {
      feedback.textContent = err.message;
      feedback.dataset.tone = "danger";
      feedback.hidden = false;
    } finally {
      setBusy(digestBtn, false);
    }
  });

  dreamBtn.addEventListener("click", async () => {
    setBusy(dreamBtn, true, "触发中…");
    try {
      await memoryClient.enqueueDream(agentId, { requestId: `dream-${Date.now()}` });
      feedback.textContent = "Dream 任务已加入队列";
      feedback.dataset.tone = "success";
      feedback.hidden = false;
      await load();
    } catch (err) {
      feedback.textContent = err.message;
      feedback.dataset.tone = "danger";
      feedback.hidden = false;
    } finally {
      setBusy(dreamBtn, false);
    }
  });

  await load();
  return () => { disposed = true; root.replaceChildren(); };
}
