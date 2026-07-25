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
  "chevron-down": [
    ["path", { d: "M7 10l5 5 5-5" }],
  ],
  command: [
    ["rect", { x: "3.5", y: "4.5", width: "17", height: "15", rx: "2.5" }],
    ["path", { d: "M7 9l3 3-3 3M13 15h4" }],
  ],
  compact: [
    ["path", { d: "M5 8h14M5 16h14M9 4l3 3 3-3M9 20l3-3 3 3" }],
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
  edit: [
    ["path", { d: "M4.5 19.5l1-4.5L15.8 4.7a2.1 2.1 0 013 3L8.5 18zM14.5 6l3 3" }],
  ],
  error: [
    ["circle", { cx: "12", cy: "12", r: "8.5" }],
    ["path", { d: "M12 7.5v5.5M12 16.5h0" }],
  ],
  menu: [
    ["rect", { x: "4", y: "5", width: "16", height: "14", rx: "2.5" }],
    ["path", { d: "M9 5v14M6.5 9h0M6.5 12h0M6.5 15h0" }],
  ],
  microphone: [
    ["rect", { x: "9", y: "3", width: "6", height: "11", rx: "3" }],
    ["path", { d: "M5.5 11a6.5 6.5 0 0013 0M12 17.5V21M8.5 21h7" }],
  ],
  observe: [
    ["path", { d: "M2.8 12s3.4-5.5 9.2-5.5 9.2 5.5 9.2 5.5-3.4 5.5-9.2 5.5S2.8 12 2.8 12z" }],
    ["circle", { cx: "12", cy: "12", r: "2.75" }],
  ],
  plan: [
    ["rect", { x: "5", y: "3.5", width: "14", height: "17", rx: "2.5" }],
    ["path", { d: "M8 8l1.3 1.3L12 6.8M8 14l1.3 1.3L12 12.8M14 8h2M14 14h2" }],
  ],
  read: [
    ["path", { d: "M3.5 5.5A8.5 8.5 0 0112 8v11a8.5 8.5 0 00-8.5-2.5zM20.5 5.5A8.5 8.5 0 0012 8v11a8.5 8.5 0 018.5-2.5z" }],
  ],
  reasoning: [
    ["path", { d: "M8.5 15.5a6 6 0 117 0c-.9.7-1.5 1.5-1.5 2.5h-4c0-1-.6-1.8-1.5-2.5zM10 21h4" }],
    ["path", { d: "M12 2V.8M4.8 5L3.9 4.1M19.2 5l.9-.9" }],
  ],
  retry: [
    ["path", { d: "M18.5 8A7.5 7.5 0 106 18M18.5 8V3.5M18.5 8H14" }],
  ],
  search: [
    ["circle", { cx: "10.5", cy: "10.5", r: "6.5" }],
    ["path", { d: "M15.5 15.5L21 21" }],
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
  status: [
    ["circle", { cx: "6", cy: "12", r: "1.5" }],
    ["circle", { cx: "12", cy: "12", r: "1.5" }],
    ["circle", { cx: "18", cy: "12", r: "1.5" }],
  ],
  tool: [
    ["path", { d: "M14.5 5.5a4 4 0 01-5 5L4 16l4 4 5.5-5.5a4 4 0 005-5l-3 3-2-2z" }],
  ],
  usage: [
    ["path", { d: "M4 20V10h4v10M10 20V4h4v16M16 20v-7h4v7M3 20.5h18" }],
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
