// The chat model may append a machine tag to its spoken reply, e.g.
//   "On it, sir. [ACTION:BUILD primitive=landing-page subject=coffee]"
//   "Noted. [MEMORY:SET palette=dark]"
// parseAction splits that into clean speech, a dispatchable action, and any
// standing preferences to remember.

// The verb after the colon ("BUILD", "SET") is tolerated but unused - dispatch
// keys off `primitive` for an action and off "every remaining pair" for
// memory, so a future [ACTION:DEPLOY ...] or [MEMORY:REMEMBER ...] still gets
// stripped from the spoken text. The body is one `[^\]]*` run rather than a
// verb pattern followed by a body pattern: two adjacent greedy patterns
// backtrack against each other, which made a long unclosed "[action:aaaa..."
// take seconds to reject. The namespace (action|memory) is captured
// separately so one scan handles both tags - two regexes that must agree
// about what a tag looks like will drift, and the failure mode is the voice
// reading a machine tag aloud.
const TAG_SOURCE = String.raw`\[\s*(action|memory)\s*:([^\]]*)\]`;
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
// garbled tag should never break speech. Shared by both namespaces - what a
// tag's pairs *mean* (an action vs. a preference) is decided by the caller.
function parsePairs(body) {
  // Drop the leading verb, if any. Anchored and separate from the pair scan, so
  // "BUILD =stray" can't be read as the pair build=stray.
  const pairs = body.replace(/^[a-z0-9_-]*/i, "");

  // Null-prototype bag so a param literally named "__proto__" is captured as data
  // instead of vanishing into the prototype chain. Spread on the way out so the
  // caller still gets an ordinary object.
  const bag = Object.create(null);

  for (const [, rawKey, rawValue] of pairs.matchAll(PAIR)) {
    const key = rawKey.toLowerCase();
    const value = unquote(rawValue);
    bag[key] = value;
  }

  return bag;
}

// An [ACTION:...] tag's bag is dispatchable only once `primitive` is pulled out
// and non-empty; everything else becomes params.
function toAction(bag) {
  const { primitive, ...params } = bag;
  // No primitive (or an empty one) means nothing to build - not dispatchable.
  return primitive ? { primitive, params } : null;
}

// A [MEMORY:...] tag has no required key - every pair is a preference. Caps
// and sanitization are lib/memory.js's job; this just decides "is there
// anything here at all."
function toMemory(bag) {
  return Object.keys(bag).length > 0 ? { ...bag } : null;
}

export function parseAction(text) {
  // A fresh object every call - a shared constant would let one caller's edit
  // leak into every later call.
  if (typeof text !== "string") return { reply: "", action: null, memory: null };

  const matches = [...text.matchAll(TAG)];
  if (matches.length === 0) return { reply: text.trim(), action: null, memory: null };

  // Close the gap the tag left: a space mid-sentence, a newline if the tag sat on
  // its own line, so the spoken line reads naturally either way.
  const reply = text
    .replace(TAG_SEAM, (seam) => (seam.includes("\n") ? "\n" : " "))
    .trim();

  let action = null;
  let memory = null;
  for (const match of matches) {
    const [, namespace, body] = match;
    const bag = parsePairs(body);

    if (namespace.toLowerCase() === "action") {
      // First dispatchable ACTION wins - unchanged from today. An action tag
      // never contributes preferences.
      if (!action) action = toAction(bag);
    } else {
      // MEMORY tags merge across all matches, in document order, so a later
      // tag's value for the same key wins. A memory tag never dispatches.
      const parsed = toMemory(bag);
      if (parsed) memory = { ...memory, ...parsed };
    }
  }

  return { reply, action, memory };
}
