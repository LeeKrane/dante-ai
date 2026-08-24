// Two decisions about a conversational turn, kept out of server.js so they can
// be unit-tested: what a call carries when someone interrupted themselves, and
// whether a turn still has the floor by the time its answer comes back.

// How many unanswered sentences ride along. Someone stuck in an interrupt loop
// must not be able to grow the prompt without limit, and the third-oldest thing
// said before an answer arrived is not context anybody wants recited back.
export const MAX_UNANSWERED = 3;

// Each one clipped. Dictation is short by nature; this only bounds the
// pathological case of a stuck recognizer emitting a paragraph.
export const MAX_TURN_CHARS = 400;

const usable = (text) => typeof text === "string" && text.trim() !== "";

// mergeTurns(texts) -> the one thing to ask.
//
// `texts` is everything said since the last spoken reply, OLDEST FIRST. The
// ordinary case is a single sentence, and that sentence comes back untouched:
// an ordinary turn must reach the model exactly as it always did, with no
// framing wrapped around it.
//
// Several means the person interrupted themselves. They are reordered newest
// first and labelled, because the most recent sentence is the request and the
// rest are only worth mentioning if they change the answer. The framing is
// stated here rather than in the persona so it costs nothing on every other
// turn of the conversation.
export function mergeTurns(texts) {
  const list = (Array.isArray(texts) ? texts : []).filter(usable);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];

  const newestFirst = list.slice(-MAX_UNANSWERED).reverse();
  const lines = newestFirst.map((text, i) => {
    const label = i === 0 ? "Most recent" : "Before that";
    return `${label}: "${text.trim().slice(0, MAX_TURN_CHARS)}"`;
  });

  return [
    "I said more than one thing before you answered. Answer the most recent. The earlier ones",
    "are context: mention them only if they change the answer.",
    "",
    ...lines,
  ].join("\n");
}

// dropAnswered(unanswered, count) -> the same list, with the sentences a reply
// has now settled removed from the front.
//
// Not `length = 0`. A reply is not spoken the instant it exists — synthesis takes
// about a second — and a sentence arriving in that window is pushed onto the very
// list being cleared. Emptying it wholesale would swallow the newest thing said
// and answer it never. Only what the reply actually addressed comes off, oldest
// first, and anything that arrived behind it stays for the call that carries it.
export function dropAnswered(unanswered, count) {
  if (!Array.isArray(unanswered)) return unanswered;
  if (!Number.isInteger(count) || count <= 0) return unanswered;
  unanswered.splice(0, count);
  return unanswered;
}

// createTurnGate() -> { begin, isCurrent }
//
// A turn that has been superseded must not speak. Checking a flag is not enough:
// a call can resolve in the same tick its abort is fired, and then the abandoned
// turn would answer a question nobody is waiting on any more. A token issued at
// the start and checked at the end settles it either way — whoever asked last
// holds the floor.
export function createTurnGate() {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    isCurrent(token) {
      return token === current;
    },
  };
}
