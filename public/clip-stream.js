// Feeding a clip to a SourceBuffer as its bytes arrive.
//
// The fifth of the pure client modules (stt-policy.js, visibility-policy.js,
// progress-policy.js, playback-policy.js). app.js owns the MediaSource, the
// media element and the audio graph, none of which exist outside a browser; the
// part with the actual rule in it lives here and is tested against a fake sink.
//
// The rule: SourceBuffer.appendBuffer throws InvalidStateError if it is called
// while a previous append is still in flight, and `updateend` is the only signal
// that one has finished. Bytes off a WebSocket do not wait for that. So the
// chunks queue, and the queue drains one append at a time.
//
// Three things make it more than a list. The sink does not exist yet when the
// first bytes land — `sourceopen` is an event, and the response is already
// streaming by the time it fires — so the queue has to outlive its absence. The
// end of the clip is a third state rather than a final chunk, because
// endOfStream() throws for the same reason appendBuffer does and truncates the
// reply if it is called with bytes still queued. And a clip cut off by the next
// one keeps receiving chunks: the server commits to a whole clip the moment it
// sends the first byte, so `stop()` has to make the rest land nowhere.

// createAppendQueue({ onEnd, onError }) -> { attach, push, finish, stop, pending }
//
// `onEnd` is called exactly once, when the last queued byte has been appended
// and the sender has said there are no more. app.js wires it to
// MediaSource.endOfStream(). `onError` means the bytes could not be appended at
// all — a quota, or a SourceBuffer detached from under us — and the clip is
// abandoned rather than retried on every subsequent updateend.
//
// `sink` is injected rather than reached for, which is what makes this testable
// with no DOM: anything with appendBuffer, updating and addEventListener will do.
export function createAppendQueue({ onEnd, onError } = {}) {
  const queue = [];
  let sink = null;
  let finished = false;
  let stopped = false;
  let ended = false;

  function drain() {
    if (stopped || !sink) return;
    // A loop rather than a single append because a sink is allowed to complete
    // synchronously; a real SourceBuffer sets `updating` inside appendBuffer and
    // this runs exactly once per updateend.
    while (queue.length && !sink.updating) {
      const chunk = queue.shift();
      try {
        sink.appendBuffer(chunk);
      } catch (e) {
        stopped = true;
        queue.length = 0;
        if (onError) onError(e);
        return;
      }
    }
    if (finished && !queue.length && !sink.updating && !ended) {
      ended = true;
      if (onEnd) onEnd();
    }
  }

  return {
    attach(s) {
      sink = s;
      s.addEventListener("updateend", drain);
      drain();
    },
    push(chunk) {
      // Silently dropped after stop() or finish(). Both mean this clip is no
      // longer taking bytes, and a chunk kept here is a chunk that would be
      // appended to the next clip's sink or held against a drain that never runs.
      if (stopped || finished) return;
      queue.push(chunk);
      drain();
    },
    finish() {
      finished = true;
      drain();
    },
    stop() {
      stopped = true;
      queue.length = 0;
    },
    pending() {
      return queue.length;
    },
  };
}
