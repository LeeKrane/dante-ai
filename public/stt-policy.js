const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed"]);

export function isFatalSpeechError(error) {
  return FATAL_ERRORS.has(error);
}

// Chrome on the desktop hands each result index over exactly once, final, and
// never revisits it, so appending every final transcript as it arrives works
// there. Chrome on Android does not: it re-delivers the *same* index with a
// longer transcript on every event and leaves `resultIndex` sitting at 0, so an
// append-only accumulator turned "How are you Jarvis" into "How How are How are
// you How are you Jarvis". Writing each transcript at its own index makes a
// re-delivery an overwrite, which is what the desktop path was already doing by
// accident — one write per index either way.
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

// Android also ignores `continuous`, so it ends the recognition session after
// every phrase and we restart it while the button is still held. Each restart
// resets `results` to index 0, which would overwrite the phrase before it —
// hence the split between `committed` (everything earlier sessions produced)
// and `finals` (the session running right now).
export function mergeTranscript(committed, finals, interim = "") {
  return [committed, ...finals, interim]
    .filter((part) => typeof part === "string" && part.trim() !== "")
    .map((part) => part.trim())
    .join(" ");
}
