import { getSpaceType } from "../../../src/spaces/space-types.js";

export function mountBlankSpaceView({ root, space } = {}) {
  const type = getSpaceType(space?.spaceType);
  root.dataset.routeScope = "management";
  const page = document.createElement("section");
  page.className = "vera-blank-space";

  const heading = document.createElement("h1");
  heading.textContent = type.label;
  const message = document.createElement("p");
  message.textContent = "这是一个空白 Space，组件搭建功能尚未开放。";

  page.append(heading, message);
  root.appendChild(page);

  return () => page.remove();
}
