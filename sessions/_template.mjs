// Copy this file to sessions/<your-id>.mjs and edit it. That is the whole
// extension mechanism: one file in, one new kind of session the assistant can
// start for you by voice.
//
// Files whose name starts with "_" are skipped by the loader, so this template
// never registers itself.
//
// A session kind is NOT a primitive. A primitive names the tools a build may
// use, because a build runs unattended in a throwaway directory and that list
// is the whole boundary. A session kind names none: a session runs in a real
// repository under your own settings, permissions and hooks, exactly as one you
// started in a terminal would. Shaping the prompt is what a kind is for.

export default {
  // Unique name for this kind of session. MUST equal the filename without .mjs.
  id: "your-session-id",

  // Phrases that hint a spoken request is this kind of session. Lowercase, short.
  triggers: ["your phrase", "another phrase"],

  // Prepended to the session's own instructions as an --append-system-prompt.
  // Receives { task, alias }: what was asked for, and the repository alias it
  // is being asked for in. Shape the work; do not restate the task.
  systemPrompt: ({ task }) => `Work carefully and explain what you changed. ${task}`,

  // Optional. A model alias ("opus", "sonnet", "fable") or a full model name.
  // Omit it to use whatever your CLI defaults to.
  // model: "opus",

  // Optional. One of low, medium, high, xhigh, max. Omit it to inherit.
  // effort: "high",

  // Optional. A short word for the session's name, used instead of the first
  // few words of the task: jarvis-3-review reads better than
  // jarvis-3-look-over-my-changes.
  // nameHint: () => "review",

  // Optional. Receives { task, brief, alias, maxChars } and, when present,
  // REPLACES the brief as the session's whole positional prompt -- not
  // appended to it, not prepended to it, the entire thing. Almost no kind
  // needs this: it exists for the one shape systemPrompt and a plain brief
  // cannot produce between them, a session whose first line is a slash
  // command. A skill only expands when it is the first line of the
  // positional prompt, and whatever follows on later lines arrives at the
  // skill as its own arguments -- which is exactly where a brief would need
  // to land for a session to open by running one. command= cannot do this
  // either: a command is one line by construction and the brief is dropped
  // on purpose when it is given (see buildStartArgs in lib/spawn-session.js).
  // `maxChars` is MAX_BRIEF_CHARS, the cap buildStartArgs re-applies to the
  // WHOLE composed prompt once it reaches the command line -- a hook that
  // composes a preamble in front of the brief should trim the brief (not the
  // preamble) to fit inside it, so a near-cap brief loses its own tail
  // rather than losing whatever the preamble pushed past the edge. See
  // sessions/brainstorm.mjs for a kind that needs both.
  // prompt: ({ task, brief, maxChars }) => `/some-skill\n\n${(brief || task).slice(0, maxChars)}`,

  // Optional boolean. True only for a kind whose `prompt` hook is trusted to
  // hand back an authoritative verdict -- gates whether a finished session's
  // OWN transcript may be lifted, verbatim, into a spoken "do this first"
  // sentence and into the recap log (extractDoThisFirst, lib/transcript.js;
  // speaksVerdict, lib/sessions.js). A transcript holds whatever the session
  // read off disk or off the web, so this defaults to false for every kind,
  // sessions with no kind at all included, and should stay false unless this
  // kind's whole point is to produce a verdict worth repeating with Dante's
  // own authority. See sessions/brainstorm.mjs, the one kind that sets it.
  // speaksVerdict: true,

  // Optional. The name of a skill this kind's `prompt` hook expects to run
  // (without the leading slash). Checked at launch, in server.js, against
  // the skills loadCommands actually found on disk (lib/commands.js) --
  // missingSkill in lib/sessions.js is the pure check -- and the start is
  // refused, by name, rather than spawning a session whose entire prompt is
  // a slash command nothing on this machine can expand.
  // skill: "some-skill",
};
