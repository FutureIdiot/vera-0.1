import { createHttpClient } from "../api/http-client.js";
import { createPathsClient } from "../api/paths-client.js";
import { createNotice, field, input, setBusy } from "../components/management-ui.js";

function formatBytes(value = 0) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export async function mountPathSettingsView({ root, platform, shell } = {}) {
  root.dataset.routeScope = "management";
  const client = createPathsClient(createHttpClient(platform));
  let paths = null;
  let disposed = false;
  shell?.setManagementHeader({ title: "Paths", backHref: "#/settings", backLabel: "返回" });
  const content = document.createElement("div");
  content.className = "vera-management-content";
  const notice = createNotice("正在读取路径状态…");
  const vault = document.createElement("section");
  vault.className = "vera-management-section";
  const vaultTitle = document.createElement("h2");
  vaultTitle.textContent = "Memory vault";
  const vaultInput = input();
  const vaultMeta = createNotice("");
  const validateVault = document.createElement("button");
  validateVault.type = "button";
  validateVault.className = "vera-secondary-button";
  validateVault.textContent = "校验目标";
  const migrateVault = document.createElement("button");
  migrateVault.type = "button";
  migrateVault.className = "vera-primary-button";
  migrateVault.textContent = "迁移并切换";
  migrateVault.disabled = true;
  vault.append(vaultTitle, field("新位置", vaultInput), vaultMeta, validateVault, migrateVault);
  const data = document.createElement("section");
  data.className = "vera-management-section";
  const dataTitle = document.createElement("h2");
  dataTitle.textContent = "Gateway dataPath（高风险）";
  const dataInput = input();
  const dataMeta = createNotice("");
  const validateData = document.createElement("button");
  validateData.type = "button";
  validateData.className = "vera-secondary-button";
  validateData.textContent = "校验迁移目标";
  const migrateData = document.createElement("button");
  migrateData.type = "button";
  migrateData.className = "vera-danger-button";
  migrateData.textContent = "备份、复制并验证";
  migrateData.disabled = true;
  data.append(dataTitle, createNotice("不能直接改写。必须校验 → 备份 → 复制 → 验证；旧路径作为回滚备份保留。"), field("迁移目标", dataInput), dataMeta, validateData, migrateData);
  content.append(notice, vault, data);
  root.appendChild(content);

  function fill() {
    vaultInput.value = paths.memory.vaultPath;
    vaultMeta.textContent = `${paths.memory.exists ? "可用" : "不存在"} · ${paths.memory.memoryCount} 条 Memory · ${paths.memory.legacyUnscopedCount} 条未归属`;
    dataInput.value = paths.gateway.dataPath;
    dataMeta.textContent = `${formatBytes(paths.gateway.sizeBytes)}${paths.gateway.restartRequired ? " · 等待重启切换" : ""}`;
  }
  async function validate(key, control, button, meta) {
    setBusy(button, true, "校验中…");
    try {
      const result = await client.validate(key, control.value);
      control.value = result.normalized ?? control.value;
      meta.textContent = [...(result.errors ?? []), ...(result.warnings ?? [])].join("；") || "校验通过，可以迁移";
      meta.dataset.tone = result.ok ? "success" : "danger";
      return result.ok;
    } catch (err) { meta.textContent = err.message; meta.dataset.tone = "danger"; return false; }
    finally { setBusy(button, false); }
  }
  validateVault.addEventListener("click", async () => { migrateVault.disabled = !(await validate("memory.vaultPath", vaultInput, validateVault, vaultMeta)); });
  validateData.addEventListener("click", async () => { migrateData.disabled = !(await validate("gateway.dataPath", dataInput, validateData, dataMeta)); });
  vaultInput.addEventListener("input", () => { migrateVault.disabled = true; });
  dataInput.addEventListener("input", () => { migrateData.disabled = true; });
  migrateVault.addEventListener("click", async () => {
    if (!window.confirm("把 Memory vault 迁移到已校验目标？")) return;
    setBusy(migrateVault, true, "迁移中…");
    try { await client.migrate("memory.vaultPath", vaultInput.value); paths = (await client.get()).paths; fill(); notice.textContent = "Memory vault 已验证并切换"; notice.dataset.tone = "success"; }
    catch (err) { notice.textContent = `迁移失败，原路径保持不动：${err.message}`; notice.dataset.tone = "danger"; }
    finally { setBusy(migrateVault, false); migrateVault.disabled = true; }
  });
  migrateData.addEventListener("click", async () => {
    if (!window.confirm("执行 dataPath 备份、复制和验证？完成后仍需重启 gateway 才切换。")) return;
    setBusy(migrateData, true, "迁移验证中…");
    try { const result = await client.migrate("gateway.dataPath", dataInput.value); paths = (await client.get()).paths; fill(); notice.textContent = result.restartRequired ? "迁移已验证；重启 gateway 后生效，旧路径保留用于回滚。" : "迁移完成"; notice.dataset.tone = "success"; }
    catch (err) { notice.textContent = `迁移失败并已回滚：${err.message}`; notice.dataset.tone = "danger"; }
    finally { setBusy(migrateData, false); migrateData.disabled = true; }
  });
  try { paths = (await client.get()).paths; if (!disposed) { fill(); notice.textContent = "路径只通过受控迁移改变，不存在直接生效文本框。"; } }
  catch (err) { notice.textContent = err.message; notice.dataset.tone = "danger"; }
  return () => { disposed = true; root.replaceChildren(); };
}
