// Copy this file to primitives/<your-id>.mjs and edit it. That is the whole
// extension mechanism: one file in, one new thing the assistant can build.
//
// Files whose name starts with "_" are skipped by the loader, so this template
// never registers itself.

export default {
  // Unique name for this kind of build. MUST equal the filename without .mjs.
  id: "your-primitive-id",

  // Phrases that hint the request is this kind of build. Lowercase, short.
  triggers: ["your phrase", "another phrase"],

  // Asked one at a time before the build starts. `key` names the answer,
  // `ask` is the sentence spoken aloud. Keep the list to two or three.
  questions: [
    { key: "subject", ask: "What should it be about?" },
    { key: "vibe", ask: "What tone are you going for?" },
  ],

  // The full instruction handed to the build session. Receives an object of the
  // answers keyed by the `key` fields above. Be specific: the build runs
  // unattended, so anything left implicit is left to chance.
  systemPrompt: (params) =>
    `Build a thing about ${params.subject} with a ${params.vibe} feel.`,

  // Least-privilege tool scope for the build. Grant only what it truly needs.
  allowedTools: ["Write", "Edit", "Read"],

  // Optional extra tool servers. Each is used only if it is configured on this
  // machine, so a missing one degrades the build rather than breaking it.
  mcp: [],

  // The file whose existence proves the build produced something. Checked
  // after the build finishes; relative to the build's working directory.
  outputContract: "index.html",

  // The line spoken when the build succeeds. Same params as systemPrompt.
  doneLine: (params) => `Your ${params.subject} thing is ready.`,

  // Optional. The line spoken as the build STARTS, before the HUD takes over.
  // Omit it and the assistant says something generic instead.
  startLine: (params) => `Starting your ${params.subject} thing now, sir.`,

  // Hard ceiling on the build, in milliseconds. Past this it is stopped.
  timeoutMs: 300000,

  // Optional. Leave it out and the build is one session, given the whole
  // directory and judged on `outputContract` above — which is what most
  // primitives want.
  //
  // Declare it and the build becomes a chain: one session per step, in order,
  // all sharing one directory, one log and one settings file, so a later step
  // reads what an earlier one wrote. Every field below is required per step and
  // nothing is inherited from the primitive — especially not `allowedTools`,
  // because a planning step has no business holding the tools a building step
  // needs.
  //
  // Two rules the loader enforces, both of which are silent disasters
  // otherwise: the LAST step's `outputContract` must equal the primitive's own
  // (that file is what decides whether the whole build succeeded), and if every
  // step states a `timeoutShareMs`, they must add up to no more than
  // `timeoutMs`.
  //
  // steps: [
  //   {
  //     id: "plan",
  //     systemPrompt: (params) => `Plan a thing about ${params.subject}. Write plan.md.`,
  //     allowedTools: ["Write"],
  //     outputContract: "plan.md",
  //     timeoutShareMs: 60000, // optional; omit it to mean "whatever is left"
  //   },
  //   {
  //     id: "build",
  //     systemPrompt: () => "Read plan.md and build it. Write index.html.",
  //     allowedTools: ["Write", "Edit", "Read"],
  //     outputContract: "index.html",
  //   },
  // ],
};
