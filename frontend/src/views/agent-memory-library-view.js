import { createHttpClient } from "../api/http-client.js";
import { createMemoryClient } from "../api/memory-client.js";
import { createNotice, field, input, select, setBusy } from "../components/management-ui.js";

export async function mountAgentMemoryLibraryView({ root, platform, runtime, agentId, shell } = {}) {
  root.dataset.routeScope = "management";
  const agent = runtime.getBootstrap().agents.find((item) => item.id === agentId);
  const client = createMemoryClient(createHttpClient(platform));
  let memories = [];
  let memoryErrors = [];
  let selected = null;
  let disposed = false;
  let dirty = false;
  const back = `#/agents/${encodeURIComponent(agentId)}/data/memory`;
  shell?.setManagementHeader({ title: `${agent?.name ?? "Agent"} Memory Library`, backHref: back, backLabel: "返回" });
  if (!agent) {
    root.appendChild(createNotice("Agent 不存在", "danger"));
    return () => root.replaceChildren();
  }
  const layout = document.createElement("div");
  layout.className = "vera-memory-layout";
  const sidebar = document.createElement("aside");
  sidebar.className = "vera-memory-list";
  const create = document.createElement("button");
  create.type = "button";
  create.className = "vera-secondary-button";
  create.textContent = "手动保存一条";
  const list = document.createElement("div");
  sidebar.append(create, list);
  const editor = document.createElement("form");
  editor.className = "vera-memory-editor";
  const notice = createNotice("正在读取索引…");
  const slug = input({ placeholder: "kebab-case-slug" });
  const type = input({ placeholder: "decision / preference / ..." });
  const description = input({ placeholder: "一行钩子" });
  const status = select("active", [["active", "active"], ["archived", "archived"]]);
  const content = document.createElement("textarea");
  content.rows = 14;
  content.placeholder = "Markdown 正文";
  const actions = document.createElement("div");
  actions.className = "vera-form-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "vera-primary-button";
  save.textContent = "保存 Memory";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "vera-danger-button";
  remove.textContent = "删除";
  actions.append(save, remove);
  editor.append(notice, field("Slug", slug, "Agent 内唯一，使用 kebab-case"), field("类型", type), field("钩子行", description), field("状态", status), field("正文", content), actions);
  layout.append(sidebar, editor);
  root.appendChild(layout);

  function setEditor(memory) {
    selected = memory;
    slug.value = memory?.slug ?? "";
    slug.readOnly = Boolean(memory);
    type.value = memory?.type ?? "";
    description.value = memory?.description ?? "";
    status.value = memory?.status ?? "active";
    content.value = memory?.content ?? "";
    remove.hidden = !memory;
    dirty = false;
    notice.textContent = memory ? `已加载 ${memory.slug}` : "新建 Memory";
  }
  function renderList() {
    list.replaceChildren();
    if (!memories.length) list.appendChild(createNotice("这个 Agent 还没有记忆，用一次就慢慢攒起来了。"));
    for (const memory of memories) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "vera-memory-row";
      button.classList.toggle("is-active", selected?.slug === memory.slug);
      const title = document.createElement("strong");
      title.textContent = memory.slug;
      const detail = document.createElement("small");
      detail.textContent = memory.description || "无钩子行";
      button.append(title, detail);
      button.addEventListener("click", async () => {
        if (dirty && !window.confirm("当前 Memory 尚未保存，确定切换？")) return;
        button.disabled = true;
        try { setEditor((await client.get(agentId, memory.slug)).memory); renderList(); }
        catch (err) { notice.textContent = err.message; notice.dataset.tone = "danger"; }
        finally { button.disabled = false; }
      });
      list.appendChild(button);
    }
  }
  function applyListResponse(response) {
    memories = response.memories ?? [];
    memoryErrors = response.errors ?? [];
  }
  function diagnosticsSuffix() {
    if (!memoryErrors.length) return "";
    const paths = memoryErrors.slice(0, 3).map((error) => error.relativePath).filter(Boolean).join("、");
    return `；另有 ${memoryErrors.length} 个文件格式异常${paths ? `（${paths}）` : ""}`;
  }
  function recoverConflict(error) {
    const reason = error?.details?.details?.reason;
    const current = error?.details?.details?.current?.memory;
    if (error?.status !== 409 || reason !== "version_mismatch" || typeof current?.content !== "string") return false;
    memories = memories.map((item) => item.slug === current.slug ? {
      slug: current.slug,
      type: current.type,
      description: current.description,
      status: current.status,
      stains: current.stains,
      sourceCount: current.sources?.length ?? 0,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      version: current.version,
    } : item);
    setEditor(current);
    renderList();
    notice.textContent = "这条刚被 agent 改过，已加载当前版本，请确认后再保存。";
    notice.dataset.tone = "danger";
    return true;
  }
  for (const control of [slug, type, description, status, content]) control.addEventListener("input", () => { dirty = true; notice.textContent = "有未保存更改"; });
  create.addEventListener("click", () => {
    if (dirty && !window.confirm("当前 Memory 尚未保存，确定新建？")) return;
    setEditor(null);
    renderList();
  });
  editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(save, true, "保存中…");
    const body = { slug: slug.value.trim(), type: type.value, description: description.value, status: status.value, content: content.value };
    try {
      const response = selected
        ? await client.update(agentId, selected.slug, {
            type: body.type,
            description: body.description,
            status: body.status,
            content: body.content,
            ifMatch: selected.version,
          })
        : await client.create(agentId, {
            slug: body.slug,
            type: body.type,
            description: body.description,
            content: body.content,
          });
      const full = await client.get(agentId, response.memory.slug);
      setEditor(full.memory);
      applyListResponse(await client.list(agentId));
      renderList();
      notice.textContent = `已保存${diagnosticsSuffix()}`;
      notice.dataset.tone = memoryErrors.length ? "danger" : "success";
    } catch (err) {
      if (!recoverConflict(err)) {
        notice.textContent = err.message;
        notice.dataset.tone = "danger";
      }
    } finally { setBusy(save, false); }
  });
  remove.addEventListener("click", async () => {
    if (!selected || !window.confirm(`删除 [[${selected.slug}]]？`)) return;
    setBusy(remove, true, "删除中…");
    try {
      await client.remove(agentId, selected.slug, selected.version);
      memories = memories.filter((item) => item.slug !== selected.slug);
      setEditor(null);
      renderList();
      if (memoryErrors.length) {
        notice.textContent = `已删除${diagnosticsSuffix()}`;
        notice.dataset.tone = "danger";
      }
    } catch (err) {
      if (!recoverConflict(err)) { notice.textContent = err.message; notice.dataset.tone = "danger"; }
    }
    finally { setBusy(remove, false); }
  });
  try {
    applyListResponse(await client.list(agentId));
    if (!disposed) {
      renderList();
      setEditor(null);
      if (memoryErrors.length) {
        notice.textContent = `已加载可用 Memory${diagnosticsSuffix()}`;
        notice.dataset.tone = "danger";
      }
    }
  } catch (err) { notice.textContent = err.message; notice.dataset.tone = "danger"; }
  return () => {
    if (dirty && !window.confirm("Memory 尚未保存，确定离开？")) return false;
    disposed = true;
    root.replaceChildren();
  };
}
