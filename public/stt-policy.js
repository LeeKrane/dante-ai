const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed"]);

export function isFatalSpeechError(error) {
  return FATAL_ERRORS.has(error);
}

// Chrome on the desktop hands each result index over exactly once, final, and
// never revisits it, so appending every final transcript as it arrives works
// there. Chrome on Android does not: it emits the phrase it has heard so far
// over and over, each time a word or two longer, so an append-only accumulator
// turned "please state your purpose" into "please please please please state
// please state your purpose".
//
// It files those growing prefixes two different ways, and both have been seen
// on real phones: rewriting the same index, and filing each one at the next
// index up. This handles the first — writing a transcript at its own index
// makes a re-delivery an overwrite, which is what the desktop path was already
// doing by accident. `mergeTranscript` handles the second, which is the shape
// this defence alone could not see.
export function applyResults(finals, resultIndex, results) {
  const next = finals.slice();
  for (let i = resultIndex; i < results.length; i++) {
    const result = results[i];
    if (!result || !result.isFinal) continue;
    next[i] = result[0].transcript;
  }
  return next;
}

// The interim transcripts of a single event. They sit after the finals but are
// never committed, because the engine rewrites them until it settles.
export function interimOf(resultIndex, results) {
  let interim = "";
  for (let i = resultIndex; i < results.length; i++) {
    const result = results[i];
    if (result && !result.isFinal) interim += result[0].transcript;
  }
  return interim;
}

// Words compare on their letters and digits alone, because the engine punctuates
// and capitalises a phrase differently every time it revises it: "please" and
// "Please," are the same word being repeated, not two words.
const WORD_KEY = /[^\p{L}\p{N}]+/gu;
const wordsOf = (text) => text.trim().split(/\s+/).filter(Boolean);
const keyOf = (word) => word.toLowerCase().replace(WORD_KEY, "");

// The join that makes a repeated prefix stop being a repeat. When the words a
// segment starts with are the words the transcript so far ends with, the engine
// is revising that tail rather than reporting new speech, so the segment
// replaces the overlap instead of following it: "please" + "please state" is
// "please state", not "please please state". The longest overlap wins, so a
// prefix that has grown by several words collapses in one step.
//
// This is deliberately blind to how the engine numbered the results, which is
// the point — `applyResults` can only collapse a rewrite it can recognise by
// index, and Android does not reliably reuse the index.
function spliceOverlap(running, next) {
  if (!running.length) return next;
  if (!next.length) return running;
  for (let k = Math.min(running.length, next.length); k > 0; k--) {
    let overlaps = true;
    for (let i = 0; i < k; i++) {
      if (keyOf(running[running.length - k + i]) !== keyOf(next[i])) {
        overlaps = false;
        break;
      }
    }
    // The newer segment wins the words it shares, because a revision is also
    // where the engine settles on the capitalisation and punctuation.
    if (overlaps) return [...running.slice(0, running.length - k), ...next];
  }
  return [...running, ...next];
}

// Android also ignores `continuous`, so it ends the recognition session after
// every phrase and we restart it while the button is still held. Each restart
// resets `results` to index 0, which would overwrite the phrase before it —
// hence the split between `committed` (everything earlier sessions produced)
// and `finals` (the session running right now).
export function mergeTranscript(committed, finals, interim = "") {
  let running = [];
  for (const part of [committed, ...finals, interim]) {
    if (typeof part !== "string" || part.trim() === "") continue;
    running = spliceOverlap(running, wordsOf(part));
  }
  return running.join(" ");
}
