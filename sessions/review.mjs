// Reads what changed and reports; it is not asked to fix anything, because a
// review that quietly rewrites the thing under review is not a review.

export default {
  id: "review",

  triggers: ["review", "code review", "look over", "check my changes"],

  systemPrompt: ({ task }) => [
    "Review the changes in this repository and report what you find.",
    "Read the diff against the default branch, and the files it touches, before saying anything.",
    "Report bugs, missed cases and anything that contradicts the repository's own conventions.",
    "Do not fix what you find and do not commit: the point of this session is the report.",
    "Finish with a short verdict someone can act on.",
    task ? `What to focus on: ${task}` : "",
  ].filter(Boolean).join(" "),

  model: "opus",
  effort: "high",

  nameHint: () => "review",
};
