import { select, setBusy } from "./management-ui.js";

export function createAccountModelControl({
  account,
  ownerAgent,
  modelOptions: providedOptions,
  updateModel,
  onSaved,
  onError,
} = {}) {
  const modelOptions = Array.isArray(providedOptions)
    ? [...new Set(providedOptions.filter((model) => typeof model === "string" && model))]
    : [];
  const currentModel = typeof account?.model === "string" ? account.model : "";
  const currentIsAvailable = modelOptions.includes(currentModel);
  const options = modelOptions.map((model) => [model, model]);
  if (currentModel && !currentIsAvailable) options.unshift([currentModel, `${currentModel}（当前不可用）`]);
  if (!options.length) options.push(["", ownerAgent ? "没有可用模型" : "等待 Agent 接入"]);
  else if (!currentModel) options.unshift(["", "请选择模型"]);

  const control = select(currentModel, options);
  if (currentModel && !currentIsAvailable) {
    const staleOption = [...control.children].find((option) => option.value === currentModel);
    if (staleOption) staleOption.disabled = true;
  }
  const save = document.createElement("button");
  save.type = "button";
  save.className = "vera-secondary-button";
  save.textContent = "保存 Model";
  const wrapper = document.createElement("span");
  wrapper.className = "vera-account-model-control";
  wrapper.append(control, save);

  const disabled = !ownerAgent || modelOptions.length === 0;
  const syncSaveState = () => {
    save.disabled = disabled || control.value === currentModel || !modelOptions.includes(control.value);
  };
  control.disabled = disabled;
  syncSaveState();
  control.addEventListener("change", syncSaveState);
  save.addEventListener("click", async () => {
    if (!account || disabled || !modelOptions.includes(control.value) || control.value === currentModel) return;
    setBusy(save, true, "保存中…");
    control.disabled = true;
    try {
      const response = await updateModel({ model: control.value, ifVersion: account.modelVersion });
      onSaved(response.account);
    } catch (error) {
      control.value = currentModel;
      onError(error);
    } finally {
      setBusy(save, false);
      control.disabled = disabled;
      syncSaveState();
    }
  });
  return wrapper;
}
