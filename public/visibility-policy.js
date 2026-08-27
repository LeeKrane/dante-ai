const VISIBILITY_KEYS = {
  t: "caption",
  h: "interface",
  d: "diagnostics",
  s: "sessions",
};

export function getVisibilityToggle(key, holding) {
  if (holding) return null;
  return VISIBILITY_KEYS[String(key).toLowerCase()] || null;
}

// The switches under the controls: every panel, in key-table order, with
// whether it is currently on. Always all four -- the line is permanent now,
// so a person can learn the keys from it, and on a phone the switches are
// the only way to toggle anything. The caller says what is visible; this
// says what to paint.
export function panelToggles(visible = {}) {
  return Object.entries(VISIBILITY_KEYS)
    .map(([key, target]) => ({ key, target, label: target, on: Boolean(visible[target]) }));
}
