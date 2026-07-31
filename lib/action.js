// The chat model may append a machine tag to its spoken reply, e.g.
//   "On it, sir. [ACTION:BUILD primitive=landing-page subject=coffee]"
// parseAction splits that into clean speech and a dispatchable action.

// The verb after the colon ("BUILD") is tolerated but unused - dispatch keys off
// `primitive`, so a future [ACTION:DEPLOY ...] still gets stripped from the spoken
// text. The body is one `[^\]]*` run rather than a verb pattern followed by a body
// pattern: two adjacent greedy patterns backtrack against each other, which made a
// long unclosed "[action:aaaa..." take seconds to reject.
const TAG_SOURCE = String.raw`\[\s*action\s*:([^\]]*)\]`;
const TAG = new RegExp(TAG_SOURCE, "gi");

// The same tag plus the whitespace on either side of it. Removing a tag leaves a
// gap, and closing it here means the rest of the reply keeps its own formatting -
// collapsing every space in the reply would silently reflow multi-line speech.
const TAG_SEAM = new RegExp(String.raw`\s*${TAG_SOURCE}\s*`, "gi");

// One key=value pair. Anchoring to a whitespace boundary (rather than letting the
// key start anywhere) keeps the scan linear on long tokens. Values may be quoted,
// because a param like subject="coffee shop" is normal and unquoted splitting
// would silently truncate it to "coffee".
const PAIR = /(?:^|\s)([^\s=]+)\s*=\s*("[^"]*"|'[^']*'|\S*)/g;

// Strip one matched pair of surrounding quotes. A lone quote is left alone - it is
// more likely part of the value than a broken quoting attempt.
function unquote(value) {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

// A tag body is whitespace-separated key=value pairs (the leading verb has no "="
// and is ignored). Anything else is dropped rather than treated as an error: a
// garbled tag should never break speech.
function parseTagBody(body) {
  // Drop the leading verb, if any. Anchored and separate from the pair scan, so
  // "BUILD =stray" can't be read as the pair build=stray.
  const pairs = body.replace(/^[a-z0-9_-]*/i, "");

  let primitive = "";
  // Null-prototype bag so a param literally named "__proto__" is captured as data
  // instead of vanishing into the prototype chain. Spread on the way out so the
  // caller still gets an ordinary object.
  const bag = Object.create(null);

  for (const [, rawKey, rawValue] of pairs.matchAll(PAIR)) {
    const key = rawKey.toLowerCase();
    const value = unquote(rawValue);
    if (key === "primitive") primitive = value;
    else bag[key] = value;
  }

  // No primitive (or an empty one) means nothing to build - not dispatchable.
  return primitive ? { primitive, params: { ...bag } } : null;
}

export function parseAction(text) {
  // A fresh object every call - a shared constant would let one caller's edit
  // leak into every later call.
  if (typeof text !== "string") return { reply: "", action: null };

  const matches = [...text.matchAll(TAG)];
  if (matches.length === 0) return { reply: text.trim(), action: null };

  // Close the gap the tag left: a space mid-sentence, a newline if the tag sat on
  // its own line, so the spoken line reads naturally either way.
  const reply = text
    .replace(TAG_SEAM, (seam) => (seam.includes("\n") ? "\n" : " "))
    .trim();

  let action = null;
  for (const match of matches) {
    action = parseTagBody(match[1]);
    if (action) break; // first dispatchable tag wins
  }

  return { reply, action };
}
