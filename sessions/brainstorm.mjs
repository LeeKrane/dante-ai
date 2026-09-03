// The prompt starts with a slash command rather than an ordinary sentence
// because that is the one thing that makes /council-review actually run: on
// CLI 2.1.259, a skill only expands when it is the first line of the
// positional prompt, and everything that follows on later lines arrives at
// the skill as its own arguments -- which is exactly how the instruction
// paragraph and the brief below reach the council. systemPrompt cannot do
// this (it is appended, not positional) and command= cannot either (a
// command is one line by construction and drops the brief on purpose --
// see buildStartArgs in lib/spawn-session.js), so `prompt` is what composes
// the whole thing. See the `prompt` field's comment in sessions/_template.mjs.
//
// This session is not asked to build anything. The council reads a brief the
// way a build session would read a plan, and the point of running it here,
// before a build session ever starts, is to hand that build session a better
// brief than the interview alone produced.

const PREAMBLE_INSTRUCTION =
  "Brainstorm the brief below and improve it. Treat it as a plan under review: debate how " +
  "each feature and feature-extension it mentions could be optimized, what is missing, " +
  "what should be cut, and what the strongest version of this plan looks like. Rewrite the " +
  "brief in the same Goal / Constraints / Done when shape as your final recommendation, so " +
  "it can be handed straight to a build session.";

export default {
  id: "brainstorm",

  // "council review this" is dropped: it contains review.mjs's own "review"
  // trigger word, and which kind a spoken request means is decided by a
  // model reading the whole flat list, not by which trigger string happens
  // to match first -- a phrase that overlaps another kind's trigger only
  // invites the model to guess wrong between them.
  triggers: ["brainstorm", "brainstorming", "brainstorming session", "debate this"],

  prompt: ({ task, brief, maxChars }) => {
    const body = (typeof brief === "string" && brief.trim()) ? brief : task;
    const preamble = ["/council-review", PREAMBLE_INSTRUCTION].join("\n\n");
    const joiner = "\n\n";

    // buildStartArgs (lib/spawn-session.js) re-caps the WHOLE composed
    // prompt at MAX_BRIEF_CHARS once it reaches the command line, and it
    // does that by slicing off the tail -- which, for a structured brief, is
    // almost always the "Done when" section. A brief that is already near
    // that cap on its own would lose that section to the two paragraphs of
    // preamble sitting in front of it. Trimming the BRIEF here instead, to
    // whatever room is left after the preamble, keeps the preamble whole (it
    // is short, fixed, and losing any of it changes what the council is
    // asked to do) and keeps the brief's head rather than its tail -- the
    // same head buildStartArgs would have kept anyway, since it also cuts
    // from the end, but doing it here makes the loss visible and testable
    // instead of a silent slice three modules away.
    const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : Infinity;
    const room = Math.max(0, budget - preamble.length - joiner.length);
    const fittedBody = body.length > room ? body.slice(0, room) : body;

    return [preamble, fittedBody].join(joiner);
  },

  systemPrompt: ({ alias }) =>
    `This is a brainstorming session in repository ${alias}: run the council on the brief it was given ` +
    "and do not implement anything, and do not commit. The deliverable is the improved brief and the " +
    "council verdict.",

  model: "opus",
  effort: "high",

  nameHint: () => "brainstorm",

  // The council's own verdict is what makes this kind worth having, and it
  // is the one thing extractDoThisFirst (lib/transcript.js) is allowed to
  // lift out of a transcript and speak with Dante's own authority -- see
  // speaksVerdict in lib/sessions.js for why every other kind defaults to
  // false.
  speaksVerdict: true,

  // Checked at launch (server.js) against the skills loadCommands actually
  // found on disk, before this session is ever spawned -- see missingSkill
  // in lib/sessions.js. Without it, a machine with no council-review skill
  // installed would start a session whose entire prompt is a slash command
  // Claude Code cannot expand, and never say so.
  skill: "council-review",
};
