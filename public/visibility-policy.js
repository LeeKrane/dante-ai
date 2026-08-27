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

// The hint under the controls: one entry per panel that is currently off,
// in the same order as the key table, each `key` + `label`. The caller says
// what is visible; this says what to print. Empty when everything is on.
export function hiddenPanelHints(visible = {}) {
  return Object.entries(VISIBILITY_KEYS)
    .filter(([, target]) => !visible[target])
    .map(([key, target]) => ({ key, target, label: target }));
}
