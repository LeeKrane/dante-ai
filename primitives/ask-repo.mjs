// The read-only primitive. Every other file in this folder spawns a session
// that builds something; this one spawns a session to look something up. It
// answers a question about a repository in prose and touches nothing in that
// repository — the only file it ever writes is its own answer, inside its own
// throwaway build directory, exactly like every other primitive's artifact.
//
// `allowedTools` is deliberately narrow: Read, Grep, Glob, nothing else. That
// list is not what keeps the session out of the repository's business, though
// — lib/builder.js's own README is explicit that allowedTools is not a
// sandbox. What actually removes Bash, Task, WebFetch and WebSearch is the
// `--disallowedTools` floor those tools fall into by NOT being requested here
// (REACHES_OUTSIDE in lib/builder.js). The systemPrompt below carries the rest
// of the promise — no edits, no commands, no guessing — because that is the
// only lever this file is allowed to pull.

export default {
  id: "ask-repo",

  triggers: [
    "ask the repo",
    "read only question",
    "read-only question",
    "explain the repo",
    "explain the code",
    "what does the code do",
    "look at the repo",
    "answer a question about the repo",
  ],

  questions: [
    { key: "repo", ask: "Which repository?" },
    { key: "question", ask: "What do you want to know?" },
  ],

  systemPrompt: (params) =>
    [
      `Answer a question about the repository at ${params.repo}.`,
      "",
      `The question: ${params.question}`,
      "",
      "You may only read. Use Read, Grep and Glob to find the answer inside that",
      "repository. Do not run any command, do not fetch anything from the network,",
      "and do not write, edit or delete anything inside that repository — you are",
      "here to read it, not to change it.",
      "",
      "Write your answer, in plain prose, in a single file named index.html in the",
      "CURRENT directory (not the repository above). That file is the only thing",
      "you write anywhere. Keep the markup minimal and legible: a <title>, a",
      "heading with the question, and the answer as ordinary paragraphs — this is",
      "a written answer, not a designed page.",
      "",
      "Quote real file paths and short excerpts to back up what you say. If you",
      "cannot find the repository, or cannot answer with confidence, say exactly",
      "that in the file rather than guessing.",
      "",
      "Write the file, then stop. Do not explain yourself afterwards.",
    ].join("\n"),

  allowedTools: ["Read", "Grep", "Glob"],

  outputContract: "index.html",

  doneLine: (params) => `Here's what I found about ${params.repo}, sir.`,

  startLine: (params) => `Let me have a look through ${params.repo}, sir.`,

  // No design craft to produce and nothing to install first — just reading and
  // writing up one answer. Generous next to a real build, still far short of
  // landing-page's ten minutes.
  timeoutMs: 300000,
};
