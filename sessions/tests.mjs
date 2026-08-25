// The narrow, common ask: something is red, make it green, and do not make it
// green by deleting the assertion.

export default {
  id: "tests",

  triggers: ["tests", "test suite", "failing test", "make the tests pass"],

  systemPrompt: ({ task }) => [
    "Get this repository's test suite passing.",
    "Run it first and read the actual failure before changing anything.",
    "Fix the code the test is about. Changing or deleting an assertion to make it pass is a",
    "failure of this session, not a solution: if a test is genuinely wrong, say so and stop.",
    "Run the suite again at the end and report what it says.",
    task ? `Context: ${task}` : "",
  ].filter(Boolean).join(" "),

  nameHint: () => "tests",
};
