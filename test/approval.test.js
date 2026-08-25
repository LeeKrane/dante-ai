import test from "node:test";
import assert from "node:assert/strict";

import { buildDecision, inApprovalScope, parseYesNo } from "../lib/approval.js";

const ROOT = "/home/krane/development/jarvis";

// ---------------------------------------------------------------------------
// inApprovalScope -- decides whether you get interrupted
// ---------------------------------------------------------------------------

test("a write inside the session's own repository is not worth interrupting anyone about", () => {
  for (const path of [`${ROOT}/lib/x.js`, `${ROOT}/deep/nested/file.txt`, "lib/relative.js", ROOT]) {
    assert.equal(inApprovalScope("Write", { file_path: path }, ROOT), null, path);
  }
});

test("a write outside the repository is asked about by name", () => {
  const scope = inApprovalScope("Write", { file_path: "/etc/hosts" }, ROOT);
  assert.equal(scope.kind, "outside-repo");
  assert.match(scope.spoken, /outside the repo/);
  assert.match(scope.spoken, /etc\/hosts/);
});

test("a path that climbs out of the repository is outside it", () => {
  // The one case a startsWith on the raw string would get wrong.
  assert.equal(inApprovalScope("Edit", { file_path: `${ROOT}/../secrets.txt` }, ROOT).kind, "outside-repo");
  assert.equal(inApprovalScope("Edit", { file_path: "../../.ssh/id_ed25519" }, ROOT).kind, "outside-repo");
});

test("a sibling directory that merely starts with the same name is outside", () => {
  // /home/krane/development/jarvis-notes is not inside /home/krane/development/jarvis.
  assert.equal(inApprovalScope("Write", { file_path: `${ROOT}-notes/x` }, ROOT).kind, "outside-repo");
});

test("every tool that writes is covered, and reading is not", () => {
  for (const tool of ["Write", "Edit", "MultiEdit"]) {
    assert.equal(inApprovalScope(tool, { file_path: "/etc/hosts" }, ROOT).kind, "outside-repo", tool);
  }
  assert.equal(inApprovalScope("NotebookEdit", { notebook_path: "/etc/x.ipynb" }, ROOT).kind, "outside-repo");
  for (const tool of ["Read", "Grep", "Glob", "WebFetch", "Task"]) {
    assert.equal(inApprovalScope(tool, { file_path: "/etc/hosts" }, ROOT), null, tool);
  }
});

test("anything that leaves the machine is asked about", () => {
  const cases = [
    ["git push origin main", /push to the remote/],
    ["git push --force", /push to the remote/],
    ["gh pr create --fill", /pull request/],
    ["gh release create v1.0.0", /release/],
    ["npm publish --access public", /npm/],
  ];
  for (const [command, spoken] of cases) {
    const scope = inApprovalScope("Bash", { command }, ROOT);
    assert.equal(scope?.kind, "publish", command);
    assert.match(scope.spoken, spoken);
  }
});

test("the interesting half of a chained command is usually at the end", () => {
  assert.equal(inApprovalScope("Bash", { command: "cd /tmp && git push" }, ROOT).kind, "publish");
  assert.equal(inApprovalScope("Bash", { command: "npm test && gh pr create" }, ROOT).kind, "publish");
});

test("ordinary commands do not interrupt anyone", () => {
  for (const command of ["npm test", "git status", "git commit -m 'x'", "ls", "git log --oneline", "npm run build"]) {
    assert.equal(inApprovalScope("Bash", { command }, ROOT), null, command);
  }
});

test("a call with nothing to judge is not a question", () => {
  assert.equal(inApprovalScope("Write", { file_path: "" }, ROOT), null);
  assert.equal(inApprovalScope("Bash", { command: "" }, ROOT), null);
  assert.equal(inApprovalScope("Write", null, ROOT), null);
  assert.equal(inApprovalScope(null, { file_path: "/etc/hosts" }, ROOT), null);
  // Without a root, every write in the repo would be "outside" one.
  assert.equal(inApprovalScope("Write", { file_path: "/etc/hosts" }, "relative/root"), null);
  assert.equal(inApprovalScope("Write", { file_path: "/etc/hosts" }, null), null);
});

test("a spoken line carries no control characters, whatever the tool input held", () => {
  const rlo = String.fromCharCode(0x202e);
  const scope = inApprovalScope("Write", { file_path: `/etc/ho${rlo}sts` }, ROOT);
  assert.equal(scope.spoken.includes(rlo), false);
});

// ---------------------------------------------------------------------------
// parseYesNo -- decides whether a git push happens
// ---------------------------------------------------------------------------

test("the words people actually say for yes are yes", () => {
  for (const text of ["yes", "Yes.", "yeah", "yep", "sure", "ok", "okay", "go ahead", "do it", "allow it", "approved", "yes please"]) {
    assert.equal(parseYesNo(text), "yes", text);
  }
});

test("the words people actually say for no are no", () => {
  for (const text of ["no", "No!", "nope", "nah", "deny", "cancel", "stop", "don't", "do not", "no way", "hold off"]) {
    assert.equal(parseYesNo(text), "no", text);
  }
});

test("a word that merely contains yes or no is not an answer", () => {
  // The failure that matters: "yesterday" must not authorise a push.
  for (const text of ["yesterday it worked", "there is no problem in november", "notes", "nothing"]) {
    assert.notEqual(parseYesNo(text), "yes", text);
  }
  assert.equal(parseYesNo("yesterday it worked"), "unclear");
});

test("an answer that says both is not an answer", () => {
  assert.equal(parseYesNo("yes, no, wait"), "unclear");
  assert.equal(parseYesNo("not yes"), "unclear");
  assert.equal(parseYesNo("no, go ahead"), "unclear");
});

test("anything this cannot read is unclear rather than guessed at", () => {
  for (const text of ["", "   ", "hmm", "what did you say", "the builder test", null, undefined, 42, {}]) {
    assert.equal(parseYesNo(text), "unclear", String(text));
  }
});

// ---------------------------------------------------------------------------
// buildDecision
// ---------------------------------------------------------------------------

test("a decision is the shape the hook contract asks for", () => {
  assert.deepEqual(buildDecision("yes", "approved by voice"), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "approved by voice",
    },
  });
  assert.equal(buildDecision("no").hookSpecificOutput.permissionDecision, "deny");
});

test("no answer is no decision, which is not the same as a denial", () => {
  // A session started while you are away must fall through to what it would
  // have done, not be denied by silence.
  assert.deepEqual(buildDecision("unclear"), {});
  assert.deepEqual(buildDecision(null), {});
  assert.deepEqual(buildDecision("allow"), {});
  assert.deepEqual(buildDecision(), {});
});
