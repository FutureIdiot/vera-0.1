import { createHttpClient } from "../api/http-client.js";
import { createExtensionsClient } from "../api/extensions-client.js";
import { createNotice, field, input, setBusy } from "../components/management-ui.js";

export async function mountExtensionsSettingsView({ root, platform, shell } = {}) {
  root.dataset.routeScope = "management";
  shell?.setManagementHeader({ title: "Extensions", backHref: "#/settings", backLabel: "返回" });
  const client = createExtensionsClient(createHttpClient(platform));
  const content = document.createElement("div");
  content.className = "vera-management-content";
  const section = document.createElement("section");
  section.className = "vera-management-section";
  const formSection = document.createElement("section");
  formSection.className = "vera-management-section";
  const path = input({ placeholder: "/absolute/path/to/extension" });
  const register = document.createElement("button");
  register.type = "button";
  register.className = "vera-primary-button";
  register.textContent = "登记外部目录";
  let extensions = [];
  let error = null;
  let disposed = false;

  function render() {
    section.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = "已登记的外部模块";
    section.appendChild(heading);
    if (error) section.appendChild(createNotice(`读取失败：${error}`, "danger"));
    else if (!extensions.length) section.appendChild(createNotice("还没有登记外部模块"));
    for (const extension of extensions) {
      const card = document.createElement("article");
      card.className = "vera-management-card";
      const name = document.createElement("strong");
      name.textContent = `${extension.name} · ${extension.version}`;
      const state = document.createElement("span");
      state.textContent = `${extension.extensionId} · ${extension.status}`;
      const unload = document.createElement("button");
      unload.type = "button";
      unload.className = "vera-secondary-button";
      unload.textContent = "卸载运行实例";
      unload.disabled = extension.status === "registered";
      unload.addEventListener("click", async () => {
        setBusy(unload, true, "处理中…");
        try { await client.unload(extension.extensionId, extension.bindingVersion); await load(); }
        catch (reason) { error = reason.message; render(); }
      });
      card.append(name, document.createElement("br"), state, unload);
      section.appendChild(card);
    }
    formSection.replaceChildren();
    const formHeading = document.createElement("h2");
    formHeading.textContent = "登记外部目录";
    const form = document.createElement("div");
    form.className = "vera-inline-form";
    register.disabled = false;
    form.append(field("外部项目路径", path), register);
    formSection.append(formHeading, form, createNotice("只登记明确提供的绝对路径；登记不会自动绑定任何 Agent。"));
    content.replaceChildren(section, formSection);
  }

  async function load() {
    try { extensions = (await client.list()).extensions ?? []; error = null; }
    catch (reason) { extensions = []; error = reason.message; }
    if (!disposed) render();
  }
  register.addEventListener("click", async () => {
    setBusy(register, true, "校验中…");
    try { await client.register(path.value); path.value = ""; error = null; await load(); }
    catch (reason) { error = reason.message; render(); }
    finally { if (!disposed) setBusy(register, false); }
  });
  root.appendChild(content);
  await load();
  return () => { disposed = true; root.replaceChildren(); };
}
