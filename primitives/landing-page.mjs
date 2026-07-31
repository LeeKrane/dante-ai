// A single-file landing page: one artifact, no dependencies, nothing to install
// before you can open it. The prompt below is deliberately opinionated about
// craft — a build is only as good as the direction it is given, and "make a
// landing page" with no art direction reliably produces the same generic page.

export default {
  id: "landing-page",

  triggers: ["landing page", "landing", "one pager", "marketing page"],

  questions: [
    { key: "subject", ask: "What's the landing page for?" },
    { key: "vibe", ask: "What vibe should it have?" },
  ],

  systemPrompt: (params) =>
    [
      `Build a landing page for ${params.subject}.`,
      `The visual tone should be ${params.vibe}.`,
      "",
      "Write it to a single file named index.html in the current directory.",
      "",
      "This page should look like a designer made it, not like a template.",
      "Take the time to get it right.",
      "",
      "Hard constraints:",
      "- One self-contained file. All CSS in a <style> tag in the head.",
      "- No external assets: no CDN links, no web fonts, no image URLs, no",
      "  frameworks, no build step. It must render correctly offline.",
      "- Any graphics are inline SVG or CSS. Any script is a small inline",
      "  <script> tag, and the page must be complete without it.",
      "- Real copy about the subject throughout. Never lorem ipsum, never",
      "  placeholder headings, never a bracketed TODO.",
      "",
      "Craft bar:",
      "- Commit to a real color strategy that suits the subject, not a safe",
      "  default. Pick a palette with a point of view and use it consistently.",
      "- Typography carries the design: a clear size and weight hierarchy, tight",
      "  and intentional heading spacing, body text at 65-75 characters per line.",
      "  System font stacks only, but use their full weight range.",
      "- Vary the spacing rhythm between sections so the page has a pulse. Do not",
      "  stack identically-sized blocks down the page.",
      "- Body text must clear 4.5:1 contrast against its background. Check it.",
      "- Motion, if any, is subtle and purposeful, and every animation has a",
      "  @media (prefers-reduced-motion: reduce) alternative.",
      "- It must look deliberate at every width from 360px to 1440px.",
      "",
      "Avoid these tells of a generated page: purple-to-blue gradient hero, text",
      "with a gradient clipped to it, a row of three identical icon cards, a tiny",
      "uppercase letter-spaced label above every section, thick colored left",
      "borders on cards, and decorative glassmorphism. If you catch yourself",
      "reaching for one, choose a different structure.",
      "",
      "Write the file, then stop. Do not explain the code afterwards.",
    ].join("\n"),

  allowedTools: ["Write", "Edit", "Read"],

  // Design reference lookups when available; the page still builds without it.
  mcp: ["refero"],

  outputContract: "index.html",

  doneLine: (params) => `Your landing page for ${params.subject} is ready, sir.`,

  // Quality takes as long as it takes. A run of this shape took ~90s when the
  // prompt asked for the minimum; asking for craft costs more. Generous ceiling.
  timeoutMs: 600000,
};
