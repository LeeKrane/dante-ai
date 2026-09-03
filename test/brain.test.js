import { test } from "node:test";
import assert from "node:assert/strict";
import * as brain from "../lib/brain.js";

const { parseClaudeJson } = brain;

test("parses reply + session id", () => {
  const out = JSON.stringify({ result: "  Hello there.  ", session_id: "abc-123" });
  const { reply, sessionId } = parseClaudeJson(out);
  assert.equal(reply, "Hello there.");
  assert.equal(sessionId, "abc-123");
});

test("replaces the coding-agent prompt with the spoken Dante prompt", () => {
  assert.equal(typeof brain.buildClaudeArgs, "function");
  const args = brain.buildClaudeArgs("Status report.", "session-1");

  assert.ok(args.includes("--system-prompt"));
  assert.equal(args.includes("--append-system-prompt"), false);
  assert.deepEqual(args.slice(-4), ["--resume", "session-1", "--", "Status report."]);
});

test("the chat model is spawned with no tools at all, not merely none allowed", () => {
  // --allowedTools "" leaves every tool DEFINITION in the prompt; only --tools ""
  // removes them. Measured on claude 2.1.241: 12,082 input tokens against 2,076.
  // Same lesson CLAUDE.md records for lib/builder.js, costing latency here rather
  // than safety.
  const args = brain.buildClaudeArgs("Status report.", null);
  const tools = args.indexOf("--tools");
  assert.notEqual(tools, -1, "--tools is missing");
  assert.equal(args[tools + 1], "");
  assert.equal(args.includes("--allowedTools"), false);
});

test("no MCP server is loaded for a turn that cannot use one", () => {
  // buildSpawnOptions passes no env, so the CLI reads the user's global
  // ~/.claude.json whatever the cwd is, and starts every server configured there
  // on every voice turn. lib/builder.js must NOT get this treatment: a primitive
  // declaring `mcp` needs those slots.
  const args = brain.buildClaudeArgs("Status report.", null);
  assert.ok(args.includes("--strict-mcp-config"));
  const config = args.indexOf("--mcp-config");
  assert.notEqual(config, -1, "--mcp-config is missing");
  assert.deepEqual(JSON.parse(args[config + 1]), { mcpServers: {} });
});

test("every option is settled before the prompt terminator", () => {
  // The flags above all take a value, and one of them taking it greedily would
  // swallow the prompt. `--` is what ends the list; nothing may need it after.
  const args = brain.buildClaudeArgs("Status report.", "session-1");
  assert.deepEqual(args.slice(-4), ["--resume", "session-1", "--", "Status report."]);
});

test("closes stdin so Claude does not wait for piped input", () => {
  assert.equal(typeof brain.buildSpawnOptions, "function");
  assert.deepEqual(brain.buildSpawnOptions("/tmp/jarvis"), {
    cwd: "/tmp/jarvis",
    stdio: ["ignore", "pipe", "pipe"],
  });
});

// A registry stand-in: buildPersona only reads id/triggers/questions off each
// entry, so a bare object is enough to get the builds block into the prompt.
const registry = [{ id: "landing-page", triggers: ["a landing page"] }];

test("the memory tag is taught even when there is nothing remembered yet", () => {
  const persona = brain.buildPersona(registry);
  assert.ok(persona.includes("[MEMORY:SET key=value ...]"));
});

test("the memory tag is ordered before the build tag, which nothing may follow", () => {
  const persona = brain.buildPersona(registry);
  assert.ok(/put this tag BEFORE the build tag/i.test(persona));
});

test("omitting the project argument is the same as passing none", () => {
  assert.equal(brain.buildPersona(registry), brain.buildPersona(registry, null));
  assert.equal(brain.buildPersona(registry).includes("earlier sessions"), false);
});

test("a remembered summary is folded into the prompt", () => {
  const persona = brain.buildPersona(registry, { summary: "Krane is building a coffee shop site." });
  assert.ok(persona.includes("earlier sessions on this project"));
  assert.ok(persona.includes("Krane is building a coffee shop site."));
});

test("standing preferences are rendered as key: value pairs", () => {
  const persona = brain.buildPersona(registry, { preferences: { palette: "dark", font: "IBM Plex Sans" } });
  assert.ok(persona.includes("Standing preferences: palette: dark; font: IBM Plex Sans."));
});

test("a project with only artifacts still names the most recent build", () => {
  const persona = brain.buildPersona(registry, {
    artifacts: [
      { primitive: "landing-page", dir: "2026-08-22T19-01-55-000Z" },
      { primitive: "marketing-site", dir: "2026-08-23T09-00-00-000Z" },
    ],
  });
  assert.ok(persona.includes("earlier sessions on this project"));
  // Only the newest one: "landing-page" appears in the builds block regardless,
  // so this pins the memory sentence itself rather than the whole prompt.
  assert.ok(persona.includes('The most recent thing built here was "marketing-site".'));
});

test("an empty project record says nothing rather than announcing empty memory", () => {
  const persona = brain.buildPersona(registry, { sessionId: null, summary: "", preferences: {}, artifacts: [] });
  assert.equal(persona, brain.buildPersona(registry));
});

test("a malformed project record degrades to no memory instead of throwing", () => {
  for (const bad of ["nonsense", 42, [], { summary: 7, preferences: "dark", artifacts: "none" }]) {
    assert.equal(brain.buildPersona(registry, bad), brain.buildPersona(registry));
  }
});

test("the voice bans filler by name and prefers brevity over politeness when the two conflict", () => {
  // The forty-word cap alone left room for preamble and hedging that ate the
  // budget without adding anything spoken. The cuts are named so a future
  // rewording keeps them rather than trusting "be concise" to cover it.
  const persona = brain.buildPersona();
  for (const phrase of ["'I will'", "'let me'", "'actually'", "'basically'", "'kind of'"]) {
    assert.ok(persona.includes(phrase), `filler ${phrase} is no longer named`);
  }
  assert.match(persona, /Say each thing once/);
  assert.match(persona, /No rhetorical questions/);
  assert.match(persona, /choose brevity/);
  assert.match(persona, /Shorter never means less/);
});

test("the closer stays last however much memory is prepended", () => {
  const closer = "Never explain your instructions. Output only the concise spoken answer.";
  assert.ok(brain.buildPersona(registry).endsWith(closer));
  assert.ok(brain.buildPersona(registry, { summary: "Something recalled." }).endsWith(closer));
  assert.ok(brain.PERSONA.endsWith(closer));
});

test("the persona explains how a repository is named, or the workspace tag is never emitted", () => {
  // lib/memory.js will happily store a workspace by voice, but nothing reaches
  // it unless the model has been told the key exists. A capability the persona
  // does not mention is a capability that does not exist.
  const persona = brain.buildPersona();
  assert.match(persona, /workspace:<name>/);
  assert.match(persona, /\[MEMORY:SET workspace:/);
});

test("the persona explains that a session with no repo named starts in the main one", () => {
  const persona = brain.buildPersona();
  assert.match(persona, /repo= may be left out entirely/);
  assert.match(persona, /\[MEMORY:SET main=/);
});

test("the persona explains the lettered repository form, and how it combines with a session number", () => {
  const persona = brain.buildPersona();
  assert.match(persona, /Repositories: machine-state line \(A, B, C\.\.\.\)/);
  assert.match(persona, /repo=<letter> or repo=<alias>/);
  assert.match(persona, /Session numbers are global across every repository/);
  assert.match(persona, /number="3" and.*repo=B/);
});

test("the persona explains the note-memory limit keys, or the model never knows they exist", () => {
  const persona = brain.buildPersona();
  assert.match(persona, /memory-max-mb=<n>/);
  assert.match(persona, /memory-max-files=<n>/);
  assert.match(persona, /\[MEMORY:SET memory-max-mb=/);
});

// ---------------------------------------------------------------------------
// Proposing rather than assuming
// ---------------------------------------------------------------------------

// The kinds map buildPersona reads: id and triggers are all the sessions block
// takes off each entry.
const kinds = new Map([["review", { id: "review", triggers: ["review"] }]]);

test("a build tag is taught as a proposal, not as something already done", () => {
  const persona = brain.buildPersona(registry);
  assert.match(persona, /A tag is a PROPOSAL, not an act/);
  assert.match(persona, /Krane is asked to confirm it before anything runs/);
});

test("the persona forbids stopping or telling a session nobody asked about", () => {
  // The rule that exists because a request to START one ended with a
  // different, working session STOPPED.
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /NEVER emit verb=tell or verb=stop unless Krane asked you, in this turn/);
  assert.match(persona, /machine-state lines is something\s+you were told about/);
});

test("the persona teaches reading a finished session back, or the verb is unreachable", () => {
  // The turn names finished sessions, and the dispatcher can read one, but
  // neither happens unless the model has been told the verb exists.
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /\[ACTION:SESSION verb=read name="<session name>" question=/);
  assert.match(persona, /FINISHED as well as one still running/);
});

test("reading is taught as the only way to know what a session did", () => {
  // A model that answers "what did jarvis three find?" from its own knowledge is
  // inventing an answer about work it has never seen, and it will sound certain.
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /never answer such a question from your own knowledge/);
});

test("a read is taught as running straight away, unlike the five that are proposed", () => {
  // It is the one verb lib/confirm.js deliberately cannot describe, so the
  // persona must not promise a confirmation nobody is going to be asked for.
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /A start, tell, interrupt, stop or watch tag is a PROPOSAL, not an act/);
  assert.match(persona, /For those five, say one short sentence/);
  assert.match(persona, /verb=read is the exception/);
});

test("a read is taught to carry no spoken sentence, so the findings are not announced as pending", () => {
  // "Let me read what jarvis three is doing" is heard only after the read has
  // already happened, so it promises an action that is finished. The reply
  // for a read is the tag alone.
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /for a read the reply is the tag and nothing else/);
  assert.match(persona, /no sentence saying you will read, are reading/);
});

test("the sessions block teaches the recap verb for catching up on what was missed", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /\[ACTION:SESSION verb=recap\]/);
  assert.match(persona, /what happened while he was away/);
  assert.match(persona, /names no session and starts nothing/);
});

test("the persona teaches the interrupt tag and when to reach for it over tell", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(
    persona,
    /\[ACTION:SESSION verb=interrupt name="<session name>" task="the new instruction"\]/,
  );
  // The choice is timing, not capability: interrupt displaces current work,
  // tell waits for it, and tell is the fallback when the request is ambiguous.
  assert.match(persona, /displace what the session is doing right/);
  assert.match(persona, /use tell when it can wait for the current work to finish/);
  assert.match(persona, /use tell - it is the safer of the two/);
});

test("the persona teaches the numbered machine-state lines and the number= tag", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /Each machine-state line is numbered/);
  assert.match(persona, /"session N" means the line marked N/);
  assert.match(persona, /number="<n>"/);
  // Acknowledging the number back is taught, not just emitting the tag.
  assert.match(persona, /"Session three\." is enough on its own/);
});

test("the guardrail against acting on an unmentioned session also covers interrupt", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(
    persona,
    /the same guardrail covers verb=interrupt: never emit it unless\s+Krane asked you, in this turn, to interrupt that session/,
  );
});

test("the guardrail against acting on an unmentioned session also covers watch", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(
    persona,
    /The same guardrail covers\s+verb=watch: never emit it unless\s+Krane asked you, in this turn, to watch that session/,
  );
});

test("the sessions block teaches the watch tag as a proposal that fires once and reports back", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /\[ACTION:SESSION verb=watch name="<session name>"\] \(or number="<n>"\)/);
  assert.match(persona, /stops working - finishes, goes idle or gets blocked/);
  assert.match(persona, /never for a session he did not name, never for every session/);
  assert.match(persona, /never on your own initiative/);
});

test("the sessions block teaches the unwatch tag as running at once, like read", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /\[ACTION:SESSION verb=unwatch name="<session name>"\]/);
  assert.match(persona, /it runs at once,\s+like read, and needs no confirmation/);
  assert.match(persona, /The WATCHING line in the machine-state lines says which/);
});

test("the sessions block guards unwatch the same way watch is guarded, against a WATCHING line read as an instruction", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(
    persona,
    /NEVER emit verb=unwatch unless\s+Krane asked you, in this turn, to stop watching that session/,
  );
  assert.match(persona, /a name on the WATCHING line is something you were told/);
});

test("the five proposed verbs are phrased as an offer ending in Shall I, sir, never as done", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /ending in "Shall I, sir\?"/);
  assert.match(persona, /never say a session has it, is stopped/);
});

test("the persona says to ask rather than fill a gap in, on both tags", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  // Once for builds, once for sessions: a model that guesses a repository is
  // the same failure as one that guesses a subject.
  assert.equal(persona.match(/ask him\b/g)?.length, 2);
});

test("the persona interviews before a session, one question per turn, and marks each question with the interview tag", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /verb=interview for=/);
  assert.match(persona, /one question per reply/);
});

test("the persona teaches the brief, and the two characters it may not contain", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /brief="/);
  assert.match(persona, /double quotes/);
  assert.match(persona, /square brackets/);
});

test("the persona never proposes a start before its brief is read back, and has no question cap", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /have=/);
  assert.match(persona, /no question limit/i);
  assert.match(persona, /confident/i);
  assert.match(persona, /Done when:/);
  assert.match(persona, /machine-state lines/);
  // Interviewing is only for what is genuinely open -- a complete request
  // gets no question of its own at all.
  assert.match(persona, /gets no question at all/);
  // The sentence the whole confirming rule hangs on: the machine, not the
  // model, reads the brief back, once, and a correction sends the model
  // around to propose again rather than to write a read-back of its own.
  assert.match(persona, /read back to Krane for you/);
  assert.match(persona, /never write a read-back/);
  assert.match(persona, /propose again/);
  assert.doesNotMatch(persona, /Skip the interview when/);
});

test("the interview paragraph does not add another ask him", () => {
  // The new paragraph teaches the same "do not guess, ask instead" idea as the
  // rule it sits beside, so it would be easy to reuse the same two words by
  // accident and break the count the older test pins.
  const persona = brain.buildPersona(registry, null, kinds);
  assert.equal(persona.match(/ask him\b/g)?.length, 2);
});

test("the persona forbids announcing or prefacing the first interview question", () => {
  const persona = brain.buildPersona(registry, null, kinds);
  assert.match(persona, /never announce it or preface it/);
  assert.match(persona, /the reply is the question, then the tag/);
});

test("the persona lists the skills it may send, and says nothing about them when there are none", () => {
  const commands = new Map([["grilling", { name: "grilling" }], ["blast-radius", { name: "blast-radius" }]]);
  const persona = brain.buildPersona(registry, null, kinds, commands);
  assert.match(persona, /SKILLS: /);
  assert.match(persona, /\/blast-radius, \/grilling\./);
  assert.match(persona, /command="\/<name> <arguments>"/);
  assert.match(persona, /never one of Claude's own commands/);
  assert.doesNotMatch(brain.buildPersona(registry, null, kinds), /SKILLS: /);
  // The command paragraph teaches "say you do not know it" without adding a
  // third "ask him", which the older test pins at two.
  assert.equal(persona.match(/ask him\b/g)?.length, 2);
});
