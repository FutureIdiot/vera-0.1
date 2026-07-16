import { createHttpClient } from "../api/http-client.js";
import { createFilesClient, FILE_ACCEPT } from "../api/files-client.js";
import { createSpacesClient } from "../api/spaces-client.js";
import { createNotice, setBusy } from "../components/management-ui.js";

function formatBytes(value = 0) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function policyLabel(policy) {
  if (policy === "specifiedShared") return "当前策略：仅 owner Space 与明确共享的 Space 可读";
  if (policy === "globalReadable") return "当前策略：所有 Space 可读；管理权仍属于 owner Space";
  return "当前策略：仅 owner Space 可读";
}

export async function mountSpaceFilesView({ root, platform, runtime, spaceId, shell } = {}) {
  root.dataset.routeScope = "management";
  const http = createHttpClient(platform);
  const filesClient = createFilesClient(http);
  const spacesClient = createSpacesClient(http);
  let mounted = true;
  let spaces = [];
  let space = null;
  let loading = false;

  shell?.setManagementHeader({
    title: "Files",
    backHref: `#/spaces/${encodeURIComponent(spaceId)}`,
    backLabel: "返回",
  });

  const content = document.createElement("div");
  content.className = "vera-management-content";
  const notice = createNotice("正在读取附件…");
  const toolbar = document.createElement("div");
  toolbar.className = "vera-form-actions";
  const upload = document.createElement("button");
  upload.type = "button";
  upload.className = "vera-primary-button";
  upload.textContent = "上传附件";
  const policy = createNotice("");
  const list = document.createElement("div");
  list.className = "vera-file-list";
  toolbar.appendChild(upload);
  content.append(notice, toolbar, policy, list);
  root.appendChild(content);

  async function saveSharing(file, details) {
    const sharedSpaceIds = [...details.querySelectorAll("input[type=checkbox]")]
      .filter((input) => input.checked)
      .map((input) => input.value);
    const button = details.querySelector("button");
    setBusy(button, true, "保存中…");
    try {
      await filesClient.updateSharing(space.id, file.id, sharedSpaceIds, file.version);
      await reload();
      notice.textContent = "共享范围已保存";
      notice.dataset.tone = "success";
    } catch (error) {
      notice.textContent = error.message;
      notice.dataset.tone = "danger";
    } finally {
      setBusy(button, false);
    }
  }

  function renderFile(file) {
    const row = document.createElement("section");
    row.className = "vera-file-row";
    const summary = document.createElement("div");
    summary.className = "vera-file-row__summary";
    const name = document.createElement("strong");
    name.textContent = file.name;
    const meta = document.createElement("small");
    meta.textContent = `${formatBytes(file.sizeBytes)} · ${file.mime} · ${
      file.canManage ? "当前 Space 所有" : `来自 ${file.ownerSpace?.name ?? file.ownerSpaceId}`
    }`;
    summary.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "vera-form-actions";
    const download = document.createElement("a");
    download.className = "vera-secondary-button vera-button-link";
    download.href = filesClient.downloadHref(space.id, file.id);
    download.download = file.name;
    download.textContent = "下载";
    actions.appendChild(download);
    row.append(summary, actions);

    if (file.canManage && !space.archivedAt) {
      const details = document.createElement("details");
      details.className = "vera-file-sharing";
      const toggle = document.createElement("summary");
      toggle.textContent = "共享范围";
      details.appendChild(toggle);
      for (const candidate of spaces.filter((item) => item.id !== space.id && !item.archivedAt)) {
        const label = document.createElement("label");
        label.className = "vera-check";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = candidate.id;
        checkbox.checked = file.sharedSpaceIds.includes(candidate.id);
        const text = document.createElement("span");
        text.textContent = candidate.name;
        label.append(checkbox, text);
        details.appendChild(label);
      }
      const save = document.createElement("button");
      save.type = "button";
      save.className = "vera-secondary-button";
      save.textContent = "保存共享范围";
      save.addEventListener("click", () => void saveSharing(file, details));
      details.appendChild(save);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "vera-danger-button";
      remove.textContent = "删除附件";
      remove.addEventListener("click", async () => {
        if (!window.confirm(`删除附件“${file.name}”？历史消息会保留不可用标记。`)) return;
        setBusy(remove, true, "删除中…");
        try {
          await filesClient.delete(space.id, file.id, file.version);
          await reload();
          notice.textContent = "附件已删除";
          notice.dataset.tone = "success";
        } catch (error) {
          notice.textContent = error.message;
          notice.dataset.tone = "danger";
        } finally {
          setBusy(remove, false);
        }
      });
      actions.appendChild(remove);
      row.appendChild(details);
    }
    return row;
  }

  async function reload() {
    if (!mounted || loading || !space) return;
    loading = true;
    try {
      const result = await filesClient.list(space.id);
      if (!mounted) return;
      list.replaceChildren(...result.files.map(renderFile));
      policy.textContent = policyLabel(result.policy);
      notice.textContent = result.files.length ? "" : "这个 Space 还没有附件。";
      notice.dataset.tone = "";
    } catch (error) {
      if (!mounted) return;
      notice.textContent = error.message;
      notice.dataset.tone = "danger";
    } finally {
      loading = false;
    }
  }

  upload.addEventListener("click", async () => {
    if (!space || space.archivedAt) return;
    setBusy(upload, true, "上传中…");
    notice.textContent = "";
    try {
      const selection = await platform.pickFile({ accept: FILE_ACCEPT });
      if (selection?.unsupported) {
        notice.textContent = "当前平台不支持选择文件。";
        return;
      }
      await filesClient.upload(space.id, selection);
      await reload();
      notice.textContent = "附件上传完成";
      notice.dataset.tone = "success";
    } catch (error) {
      await reload();
      notice.textContent = error.message;
      notice.dataset.tone = "danger";
    } finally {
      setBusy(upload, false);
    }
  });

  try {
    const all = await spacesClient.listSpaces({ archived: "all" });
    spaces = all.spaces;
    space = spaces.find((candidate) => candidate.id === spaceId) ?? null;
    if (!space) {
      notice.textContent = "Space 不存在。";
      notice.dataset.tone = "danger";
      upload.disabled = true;
    } else {
      upload.disabled = Boolean(space.archivedAt);
      if (space.archivedAt) notice.textContent = "这个 Space 已归档；附件保持只读。";
      await reload();
    }
  } catch (error) {
    notice.textContent = error.message;
    notice.dataset.tone = "danger";
    upload.disabled = true;
  }

  const unsubscribe = runtime.subscribe((envelope) => {
    if (!mounted) return;
    if (envelope.type === "runtime.connection" && envelope.data?.status !== "open") {
      notice.textContent = "重连中，附件列表暂时冻结。";
      return;
    }
    if (["file.created", "file.updated", "file.deleted"].includes(envelope.type)) void reload();
    if (envelope.type === "space.deleted" && envelope.data?.spaceId === spaceId) {
      notice.textContent = "这个 Space 已删除。";
      upload.disabled = true;
      list.replaceChildren();
    }
  }, { since: runtime.getBootstrap().seq });

  return () => {
    mounted = false;
    unsubscribe();
    root.replaceChildren();
  };
}
