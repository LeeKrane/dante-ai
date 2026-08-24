import { statSync } from "node:fs";
import { isAbsolute, normalize, resolve, sep } from "node:path";

// A streamed build emits one JSON object per line. The last one is a `result`
// event carrying the model's own verdict, which is a stronger signal than the
// exit code: a process can exit 0 having given up mid-task.
export function parseResultEvent(line) {
  if (typeof line !== "string") return null;
  let event;
  try { event = JSON.parse(line); }
  catch { return null; } // partial or non-JSON lines are normal while streaming
  if (!event || typeof event !== "object") return null;
  return event.type === "result" ? event : null;
}

// A primitive declares its output contract as a path relative to the build's
// working directory. An absolute path, or one that climbs out with "..", would
// resolve somewhere the build never touched — and `/etc/hosts` always existing
// would report a build that wrote nothing as a success. Reject instead.
export function contractIsUsable(outputContract) {
  if (typeof outputContract !== "string" || outputContract === "") return false;
  if (outputContract.includes("\0")) return false; // fs throws on these rather than reporting them
  if (isAbsolute(outputContract)) return false;
  const normalized = normalize(outputContract);
  return normalized !== ".." && !normalized.startsWith(`..${sep}`);
}

// The output contract is the file the build was asked to produce. Checking it
// exists is what separates "the process ended" from "the work got done".
function artifactExists(dir, outputContract) {
  if (typeof dir !== "string" || dir === "" || dir.includes("\0")) return false;
  if (!contractIsUsable(outputContract)) return false;
  try {
    const stats = statSync(resolve(dir, outputContract), { throwIfNoEntry: false });
    return Boolean(stats?.isFile());
  } catch {
    // `throwIfNoEntry: false` only covers a missing file. A name too long for
    // the filesystem, an unreadable parent, a symlink loop — all still throw,
    // and none of them are worth crashing the caller over: we cannot see the
    // artifact, so as far as the contract goes it is not there.
    return false;
  }
}

// Both entry points take one options object. A positional call — the shape an
// earlier draft of this contract used — would otherwise destructure to
// undefined and quietly report every single build as a failure.
function asOptions(argument, name) {
  if (argument === undefined || argument === null) return {};
  if (typeof argument !== "object") {
    throw new TypeError(`${name}() takes one options object, e.g. ${name}({ code, dir, outputContract }).`);
  }
  return argument;
}

export function buildSucceeded(input) {
  const { code, dir, outputContract, result } = asOptions(input, "buildSucceeded");
  if (code !== 0) return false;
  if (result && result.is_error === true) return false;
  return artifactExists(dir, outputContract);
}

// A chain reports which of its steps gave up. Appended rather than woven in, so
// every reason below reads the same whether or not there were steps at all, and
// spoken as words because this sentence is read aloud: "build-pages" would be
// pronounced as a filename.
function withStep(message, failedStep) {
  if (!message) return message; // nothing went wrong, so there is nothing to place
  if (typeof failedStep !== "string" || failedStep.trim() === "") return message;
  return `${message} It stopped at the ${failedStep.trim().replace(/[-_]+/g, " ")} step.`;
}

// Ordered by root cause, not by symptom: a timeout also produces a bad exit
// code and a missing file, so naming the timeout is the honest answer.
export function describeFailure(input) {
  const { code, dir, outputContract, result, timedOut, failedStep } = asOptions(input, "describeFailure");
  const reason = describeReason({ code, dir, outputContract, result, timedOut });
  return withStep(reason, failedStep);
}

function describeReason({ code, dir, outputContract, result, timedOut }) {
  if (timedOut) return "The build ran out of time before it finished.";
  if (result && result.is_error === true) {
    return "The model reported an error and stopped before finishing.";
  }
  // A process killed by a signal reports a null exit code, and "exit code null"
  // is not a sentence anyone wants read aloud.
  if (typeof code !== "number") return "The build stopped before it finished.";
  if (code !== 0) return `The build stopped with exit code ${code}.`;
  // A contract that cannot be checked is a broken primitive, not a broken
  // build, and saying so is the difference between a two-minute fix and an hour.
  if (outputContract && !contractIsUsable(outputContract)) {
    return `The output contract ${outputContract} is not a relative path inside the build folder.`;
  }
  if (!artifactExists(dir, outputContract)) {
    return `The build finished but never wrote ${outputContract || "the expected file"}.`;
  }
  return ""; // nothing went wrong, so there is nothing to explain
}
