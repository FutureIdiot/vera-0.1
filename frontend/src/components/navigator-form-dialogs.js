import { DEFAULT_SPACE_TYPE, SPACE_TYPES } from "../../../src/spaces/space-types.js";
import {
  activateNavigatorDialog,
  createNavigatorDialogButton,
  nextNavigatorDialogId,
} from "./navigator-dialogs.js";

export function requestNavigatorText(host, title, initialValue = "", { signal } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("form");
    dialog.className = "vera-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const heading = document.createElement("strong");
    heading.textContent = title;
    heading.id = nextNavigatorDialogId("vera-dialog-title");
    dialog.setAttribute("aria-labelledby", heading.id);
    const input = document.createElement("input");
    input.value = initialValue;
    input.required = true;
    input.setAttribute("aria-label", title);
    const actions = document.createElement("div");
    actions.className = "vera-dialog__actions";
    const cancel = createNavigatorDialogButton("取消", "vera-text-button", () => finish(null));
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "vera-primary-button";
    submit.textContent = "确定";
    actions.append(cancel, submit);
    dialog.append(heading, input, actions);
    host.appendChild(dialog);
    let finished = false;
    const deactivate = activateNavigatorDialog(dialog, input, () => finish(null), { signal });
    const onSubmit = (event) => {
      event.preventDefault();
      finish(input.value.trim() || null);
    };
    dialog.addEventListener("submit", onSubmit);
    function finish(value) {
      if (finished) return;
      finished = true;
      dialog.removeEventListener("submit", onSubmit);
      deactivate();
      dialog.remove();
      resolve(value);
    }
  });
}

export function requestGroupDetails(host, {
  title,
  initialValue = {},
  accounts = [],
  signal,
} = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("form");
    dialog.className = "vera-dialog vera-group-details-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const heading = document.createElement("strong");
    heading.textContent = title;
    heading.id = nextNavigatorDialogId("vera-dialog-title");
    dialog.setAttribute("aria-labelledby", heading.id);

    const nameLabel = document.createElement("label");
    nameLabel.className = "vera-dialog__field";
    const nameText = document.createElement("span");
    nameText.textContent = "群聊名称";
    const nameInput = document.createElement("input");
    nameInput.value = initialValue.name ?? "";
    nameInput.required = true;
    nameInput.setAttribute("aria-label", "群聊名称");
    nameLabel.append(nameText, nameInput);

    const topicLabel = document.createElement("label");
    topicLabel.className = "vera-dialog__field";
    const topicText = document.createElement("span");
    topicText.textContent = "主题";
    const topicInput = document.createElement("textarea");
    topicInput.value = initialValue.topic ?? "";
    topicInput.setAttribute("aria-label", "群聊主题");
    topicInput.placeholder = "这个群聊关注什么";
    topicLabel.append(topicText, topicInput);

    const members = document.createElement("fieldset");
    members.className = "vera-dialog__members";
    const membersLegend = document.createElement("legend");
    membersLegend.textContent = "成员";
    members.appendChild(membersLegend);
    const selectedIds = new Set(initialValue.accountIds ?? []);
    const memberInputs = new Map();
    for (const account of accounts) {
      const label = document.createElement("label");
      label.className = "vera-check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selectedIds.has(account.id);
      const text = document.createElement("span");
      text.textContent = account.name;
      label.append(input, text);
      members.appendChild(label);
      memberInputs.set(account.id, input);
    }

    const error = document.createElement("p");
    error.className = "vera-inline-error";
    error.hidden = true;
    const actions = document.createElement("div");
    actions.className = "vera-dialog__actions";
    const cancel = createNavigatorDialogButton("取消", "vera-text-button", () => finish(null));
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "vera-primary-button";
    submit.textContent = "保存";
    actions.append(cancel, submit);
    dialog.append(heading, nameLabel, topicLabel, members, error, actions);
    host.appendChild(dialog);

    let finished = false;
    const deactivate = activateNavigatorDialog(dialog, nameInput, () => finish(null), { signal });
    const onSubmit = (event) => {
      event.preventDefault();
      const accountIds = [...memberInputs]
        .filter(([, input]) => input.checked)
        .map(([accountId]) => accountId);
      if (accountIds.length < 2) {
        error.textContent = "群聊至少需要两个 Account。";
        error.hidden = false;
        return;
      }
      finish({
        name: nameInput.value.trim(),
        topic: topicInput.value.trim(),
        accountIds,
      });
    };
    dialog.addEventListener("submit", onSubmit);
    function finish(value) {
      if (finished) return;
      finished = true;
      dialog.removeEventListener("submit", onSubmit);
      deactivate();
      dialog.remove();
      resolve(value);
    }
  });
}

export function requestSpaceDetails(host, {
  title,
  initialValue = {},
  projects = [],
  onCreateProject = null,
  allowSpaceType = true,
  signal,
} = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("form");
    dialog.className = "vera-dialog vera-space-details-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const heading = document.createElement("strong");
    heading.textContent = title;
    heading.id = nextNavigatorDialogId("vera-dialog-title");
    dialog.setAttribute("aria-labelledby", heading.id);

    const nameLabel = document.createElement("label");
    nameLabel.className = "vera-dialog__field";
    const nameText = document.createElement("span");
    nameText.textContent = "名称";
    const nameInput = document.createElement("input");
    nameInput.value = initialValue.name ?? "";
    nameInput.required = true;
    nameInput.setAttribute("aria-label", "Space 名称");
    nameLabel.append(nameText, nameInput);

    const typeLabel = document.createElement("label");
    typeLabel.className = "vera-dialog__field";
    const typeText = document.createElement("span");
    typeText.textContent = "Space Type";
    const typeSelect = document.createElement("select");
    typeSelect.setAttribute("aria-label", "Space Type");
    typeSelect.disabled = !allowSpaceType;
    if (!allowSpaceType) typeSelect.title = "Space Type 创建后不可修改";
    for (const type of SPACE_TYPES) {
      const option = document.createElement("option");
      option.value = type.id;
      option.textContent = type.label;
      option.selected = type.id === (initialValue.spaceType ?? DEFAULT_SPACE_TYPE.id);
      typeSelect.appendChild(option);
    }
    typeLabel.append(typeText, typeSelect);

    const projectLabel = document.createElement("label");
    projectLabel.className = "vera-dialog__field";
    const projectHeading = document.createElement("span");
    projectHeading.className = "vera-dialog__field-heading";
    const projectText = document.createElement("span");
    projectText.textContent = "Project";
    projectHeading.appendChild(projectText);
    const projectSelect = document.createElement("select");
    projectSelect.setAttribute("aria-label", "Project");

    function renderProjects(nextProjects, selectedId = projectSelect.value || initialValue.projectId || "") {
      projectSelect.replaceChildren();
      const unassigned = document.createElement("option");
      unassigned.value = "";
      unassigned.textContent = "No project";
      projectSelect.appendChild(unassigned);
      for (const project of nextProjects) {
        const option = document.createElement("option");
        option.value = project.id;
        option.textContent = project.name;
        projectSelect.appendChild(option);
      }
      projectSelect.value = nextProjects.some((project) => project.id === selectedId) ? selectedId : "";
    }
    renderProjects(projects);

    if (onCreateProject) {
      const addProject = createNavigatorDialogButton(
        "新建 Project",
        "vera-dialog__inline-action",
        async () => {
          const name = await requestNavigatorText(host, "新 Project 名称", "", { signal });
          if (!name || signal?.aborted || finished) return;
          try {
            const project = await onCreateProject(name);
            if (signal?.aborted || finished) return;
            projects = [...projects.filter((candidate) => candidate.id !== project.id), project];
            renderProjects(projects, project.id);
          } catch (err) {
            if (signal?.aborted || finished) return;
            let error = dialog.querySelector(".vera-inline-error");
            if (!error) {
              error = document.createElement("span");
              error.className = "vera-inline-error";
              projectLabel.appendChild(error);
            }
            error.textContent = err.message;
          }
        },
      );
      projectHeading.appendChild(addProject);
    }
    projectLabel.append(projectHeading, projectSelect);

    const actions = document.createElement("div");
    actions.className = "vera-dialog__actions";
    const cancel = createNavigatorDialogButton("取消", "vera-text-button", () => finish(null));
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "vera-primary-button";
    submit.textContent = "保存";
    actions.append(cancel, submit);
    dialog.append(heading, nameLabel, typeLabel, projectLabel, actions);
    host.appendChild(dialog);

    let finished = false;
    const deactivate = activateNavigatorDialog(dialog, nameInput, () => finish(null), { signal });
    const onSubmit = (event) => {
      event.preventDefault();
      finish({
        name: nameInput.value.trim(),
        ...(allowSpaceType ? { spaceType: typeSelect.value } : {}),
        projectId: projectSelect.value || null,
      });
    };
    dialog.addEventListener("submit", onSubmit);
    function finish(value) {
      if (finished) return;
      finished = true;
      dialog.removeEventListener("submit", onSubmit);
      deactivate();
      dialog.remove();
      resolve(value);
    }
  });
}
