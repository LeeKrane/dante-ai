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

  // Hard ceiling on the build, in milliseconds. Past this it is stopped.
  timeoutMs: 300000,
};
