export function createSpacesState() {
  let spaces = [];
  let currentSpaceId = null;

  return {
    hydrate(nextSpaces) {
      spaces = [...nextSpaces];
      if (!spaces.some((space) => space.id === currentSpaceId)) currentSpaceId = spaces[0]?.id ?? null;
    },
    select(spaceId) {
      if (!spaces.some((space) => space.id === spaceId)) return false;
      currentSpaceId = spaceId;
      return true;
    },
    getCurrent() {
      return spaces.find((space) => space.id === currentSpaceId) ?? null;
    },
    list() {
      return [...spaces];
    },
  };
}
