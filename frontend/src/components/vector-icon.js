const ICONS = {
  "arrow-left": [
    ["path", { d: "M15 18l-6-6 6-6" }],
  ],
  bookmark: [
    ["path", { d: "M6.5 4.5h11v15l-5.5-3.5-5.5 3.5z" }],
  ],
  branch: [
    ["circle", { cx: "7", cy: "5", r: "2" }],
    ["circle", { cx: "17", cy: "7", r: "2" }],
    ["circle", { cx: "7", cy: "19", r: "2" }],
    ["path", { d: "M7 7v10M9 12h3a5 5 0 005-5" }],
  ],
  check: [
    ["path", { d: "M5 12.5l4 4L19 7" }],
  ],
  copy: [
    ["rect", { x: "8", y: "8", width: "11", height: "11", rx: "2" }],
    ["path", { d: "M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" }],
  ],
  file: [
    ["path", { d: "M20.5 11.5l-8.8 8.8a5.5 5.5 0 01-7.8-7.8l9.2-9.2a3.8 3.8 0 015.4 5.4l-9.2 9.2a2.2 2.2 0 01-3.1-3.1l8.4-8.4" }],
  ],
  image: [
    ["rect", { x: "3.5", y: "4", width: "17", height: "16", rx: "2.5" }],
    ["circle", { cx: "9", cy: "9", r: "1.5" }],
    ["path", { d: "M4 17l4.5-4.5 3.5 3 2.5-2.5 5.5 5" }],
  ],
  menu: [
    ["rect", { x: "4", y: "5", width: "16", height: "14", rx: "2.5" }],
    ["path", { d: "M9 5v14M6.5 9h0M6.5 12h0M6.5 15h0" }],
  ],
  microphone: [
    ["rect", { x: "9", y: "3", width: "6", height: "11", rx: "3" }],
    ["path", { d: "M5.5 11a6.5 6.5 0 0013 0M12 17.5V21M8.5 21h7" }],
  ],
  retry: [
    ["path", { d: "M18.5 8A7.5 7.5 0 106 18M18.5 8V3.5M18.5 8H14" }],
  ],
  send: [
    ["path", { d: "M4 4l17 8-17 8 3-8zM7 12h14" }],
  ],
  settings: [
    ["circle", { cx: "12", cy: "12", r: "3" }],
    ["path", { d: "M19 12a7 7 0 00-.1-1.2l2-1.6-2-3.4-2.5 1a8 8 0 00-2-1.2L14 3h-4l-.4 2.6a8 8 0 00-2 1.2l-2.5-1-2 3.4 2 1.6A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.5-1a8 8 0 002 1.2L10 21h4l.4-2.6a8 8 0 002-1.2l2.5 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" }],
  ],
  stop: [
    ["rect", { x: "6", y: "6", width: "12", height: "12", rx: "2" }],
  ],
};

const SVG_NS = "http://www.w3.org/2000/svg";

export function createVectorIcon(name) {
  const definition = ICONS[name];
  if (!definition) throw new TypeError(`unknown vector icon: ${name}`);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("vera-vector-icon");
  svg.dataset.icon = name;
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const [tag, attributes] of definition) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, value);
    svg.appendChild(child);
  }
  return svg;
}

export function setIconButtonContent(button, iconName, accessibleText) {
  const label = document.createElement("span");
  label.className = "vera-visually-hidden";
  label.textContent = accessibleText;
  button.replaceChildren(createVectorIcon(iconName), label);
}
