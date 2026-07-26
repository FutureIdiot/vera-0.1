const definitions = [
  { id: "chat", label: "Chat", icon: "chat", surface: "chat" },
  { id: "garage", label: "Garage", icon: "garage", surface: "placeholder" },
  { id: "library", label: "Library", icon: "library", surface: "placeholder" },
  { id: "notebook", label: "Notebook", icon: "notebook", surface: "placeholder" },
  { id: "blank", label: "Blank", icon: "blank", surface: "blank" },
];

export const SPACE_TYPES = Object.freeze(
  definitions.map((definition) => Object.freeze(definition)),
);
export const SPACE_TYPE_IDS = Object.freeze(SPACE_TYPES.map(({ id }) => id));
export const DEFAULT_SPACE_TYPE = SPACE_TYPES[0];

export function getSpaceType(spaceType) {
  return SPACE_TYPES.find(({ id }) => id === spaceType) ?? DEFAULT_SPACE_TYPE;
}

export function isSpaceType(spaceType) {
  return SPACE_TYPE_IDS.includes(spaceType);
}
