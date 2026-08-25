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
};
