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
