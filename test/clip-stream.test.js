import test from "node:test";
import assert from "node:assert/strict";
import { createAppendQueue } from "../public/clip-stream.js";

// A stand-in for SourceBuffer. `updating` and the throw are the two behaviours
// that make the queue necessary at all, so the fake reproduces both: a real
// SourceBuffer sets `updating` synchronously inside appendBuffer and throws
// InvalidStateError if a second append starts before `updateend`. `complete()`
// is the test's hand on the clock — the browser finishing one append.
function fakeSink() {
  const listeners = {};
  return {
    appended: [],
    updating: false,
    appendBuffer(chunk) {
      if (this.updating) throw new Error("InvalidStateError: appendBuffer while updating");
      this.appended.push(chunk);
      this.updating = true;
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    complete() {
      this.updating = false;
      for (const fn of listeners.updateend || []) fn();
    },
  };
}

test("bytes that arrive before the source buffer exists are not lost", () => {
  // sourceopen is a browser event and the first chunks are already on the wire
  // when it fires, so the queue has to exist before the thing it feeds.
  const q = createAppendQueue();
  q.push("a");
  q.push("b");
  assert.equal(q.pending(), 2);
  const sink = fakeSink();
  q.attach(sink);
  assert.deepEqual(sink.appended, ["a"]);
});

test("a second chunk waits for the first append to finish", () => {
  const sink = fakeSink();
  const q = createAppendQueue();
  q.attach(sink);
  q.push("a");
  q.push("b");
  // Not two. The second append would throw, which is the whole reason this
  // module exists rather than a bare appendBuffer at the message handler.
  assert.deepEqual(sink.appended, ["a"]);
  sink.complete();
  assert.deepEqual(sink.appended, ["a", "b"]);
});

test("the queue drains in the order the bytes arrived", () => {
  // Audio played out of order is not audio.
  const sink = fakeSink();
  const q = createAppendQueue();
  q.attach(sink);
  for (const c of ["a", "b", "c", "d"]) q.push(c);
  while (q.pending()) sink.complete();
  assert.deepEqual(sink.appended, ["a", "b", "c", "d"]);
});

test("the stream is only ended once every chunk has been appended", () => {
  // endOfStream() while an append is in flight throws, and endOfStream() with
  // bytes still queued truncates the reply mid-word.
  let ended = 0;
  const sink = fakeSink();
  const q = createAppendQueue({ onEnd: () => ended++ });
  q.attach(sink);
  q.push("a");
  q.push("b");
  q.finish();
  assert.equal(ended, 0);
  sink.complete();
  assert.equal(ended, 0);
  sink.complete();
  assert.equal(ended, 1);
});

test("a finish that arrives with nothing left queued ends the stream at once", () => {
  let ended = 0;
  const sink = fakeSink();
  const q = createAppendQueue({ onEnd: () => ended++ });
  q.attach(sink);
  q.finish();
  assert.equal(ended, 1);
});

test("the last chunk and the end of the clip arriving together still end it once", () => {
  let ended = 0;
  const sink = fakeSink();
  const q = createAppendQueue({ onEnd: () => ended++ });
  q.attach(sink);
  q.push("a");
  q.finish();
  sink.complete();
  assert.equal(ended, 1);
  // updateend can fire again with an empty queue; the clip must not end twice.
  sink.complete();
  assert.equal(ended, 1);
});

test("bytes still queued before the source buffer exists are ended once they go in", () => {
  let ended = 0;
  const q = createAppendQueue({ onEnd: () => ended++ });
  q.push("a");
  q.finish();
  assert.equal(ended, 0);
  const sink = fakeSink();
  q.attach(sink);
  assert.equal(ended, 0);
  sink.complete();
  assert.equal(ended, 1);
});

test("a stopped clip appends nothing more and never ends the stream", () => {
  // A clip cut off by the next one keeps receiving chunks: the server committed
  // to the whole clip when it sent the first byte. They must land nowhere — the
  // SourceBuffer they were meant for has been detached from its media element.
  let ended = 0;
  const sink = fakeSink();
  const q = createAppendQueue({ onEnd: () => ended++ });
  q.attach(sink);
  q.push("a");
  q.stop();
  sink.complete();
  q.push("b");
  q.finish();
  assert.deepEqual(sink.appended, ["a"]);
  assert.equal(q.pending(), 0);
  assert.equal(ended, 0);
});

test("a chunk pushed after stop is dropped rather than held for a sink that will never come", () => {
  const q = createAppendQueue();
  q.stop();
  q.push("a");
  assert.equal(q.pending(), 0);
});

test("an append that throws abandons the clip rather than retrying it forever", () => {
  // QuotaExceededError, or a SourceBuffer removed from under us. Either way the
  // bytes cannot go anywhere, and a queue that keeps them is a queue that keeps
  // trying on every subsequent updateend.
  const errors = [];
  const sink = fakeSink();
  sink.appendBuffer = () => { throw new Error("QuotaExceededError"); };
  const q = createAppendQueue({ onEnd: () => errors.push("ended"), onError: (e) => errors.push(e.message) });
  q.attach(sink);
  q.push("a");
  q.push("b");
  q.finish();
  assert.deepEqual(errors, ["QuotaExceededError"]);
  assert.equal(q.pending(), 0);
});

test("a sink that is already busy when it is attached is waited for rather than appended to", () => {
  const sink = fakeSink();
  sink.updating = true;
  const q = createAppendQueue();
  q.push("a");
  q.attach(sink);
  assert.deepEqual(sink.appended, []);
  sink.complete();
  assert.deepEqual(sink.appended, ["a"]);
});

test("a clip with no bytes at all still ends, rather than leaving the element stalled", () => {
  // Fish can answer 200 with an empty body. Without the end the media element
  // waits for data forever and the orb never leaves "speaking".
  let ended = 0;
  const sink = fakeSink();
  const q = createAppendQueue({ onEnd: () => ended++ });
  q.finish();
  q.attach(sink);
  assert.equal(ended, 1);
  assert.deepEqual(sink.appended, []);
});
