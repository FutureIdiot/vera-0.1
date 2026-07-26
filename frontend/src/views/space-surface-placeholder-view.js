import { getSpaceType } from "../../../src/spaces/space-types.js";

export function mountSpaceSurfacePlaceholderView({
  root,
  runtime,
  spaceId,
  space: projectedSpace = null,
} = {}) {
  const space = projectedSpace
    ?? runtime.getBootstrap().spaces.find((candidate) => candidate.id === spaceId)
    ?? null;
  const label = getSpaceType(space?.spaceType).label;

  root.dataset.routeScope = "management";
  const page = document.createElement("section");
  page.className = "vera-space-surface-placeholder";
  const heading = document.createElement("h1");
  heading.textContent = label;
  const message = document.createElement("p");
  message.textContent = `${label} 页面正在开发中`;
  page.append(heading, message);
  root.appendChild(page);

  return () => page.remove();
}
