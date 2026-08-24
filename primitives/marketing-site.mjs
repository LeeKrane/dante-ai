// A small marketing site: several self-contained pages that link to each other,
// with index.html as the front door. Unlike landing-page this runs as a chain —
// plan, build, verify — because the failure mode of asking one session for four
// linked pages in one go is that the last page is visibly worse than the first.
//
// KNOWN WEAKNESS, worth stating plainly rather than papering over: the steps
// share one directory, so a step's output contract can already exist before that
// step starts. `verify` promises index.html, which `build-pages` wrote minutes
// earlier — so buildSucceeded will pass `verify` even if it did nothing at all.
// Contract-checking inside a shared directory is inherently weaker than checking
// a fresh one, and the last step of any chain is where that bites. It is
// tolerated here because the alternative — a per-step scratch directory — breaks
// the one thing the chain is for, which is a later step reading what an earlier
// one wrote. Treat `verify` as a pass over the work, not as a gate.

const CRAFT = [
  "Hard constraints, every page:",
  "- One self-contained file per page. All CSS in a <style> tag in the head.",
  "- No external assets: no CDN links, no web fonts, no image URLs, no",
  "  frameworks, no build step. Every page must render correctly offline.",
  "- Any graphics are inline SVG or CSS. Any script is a small inline",
  "  <script> tag, and the page must be complete without it.",
  "- Real copy about the subject throughout. Never lorem ipsum, never",
  "  placeholder headings, never a bracketed TODO.",
  "- Every link between pages is a plain relative href to a file that exists.",
  "",
  "Craft bar:",
  "- One color strategy and one type scale across the whole site. A visitor",
  "  should not be able to tell which page was written first.",
  "- Typography carries the design: a clear size and weight hierarchy, tight",
  "  and intentional heading spacing, body text at 65-75 characters per line.",
  "  System font stacks only, but use their full weight range.",
  "- Vary the spacing rhythm between sections so a page has a pulse. Do not",
  "  stack identically-sized blocks down the page.",
  "- Body text must clear 4.5:1 contrast against its background. Check it.",
  "- Motion, if any, is subtle and purposeful, and every animation has a",
  "  @media (prefers-reduced-motion: reduce) alternative.",
  "- Every page must look deliberate at every width from 360px to 1440px.",
  "",
  "Avoid these tells of a generated page: purple-to-blue gradient hero, text",
  "with a gradient clipped to it, a row of three identical icon cards, a tiny",
  "uppercase letter-spaced label above every section, thick colored left",
  "borders on cards, and decorative glassmorphism. If you catch yourself",
  "reaching for one, choose a different structure.",
].join("\n");

export default {
  id: "marketing-site",

  triggers: ["marketing site", "multi page site", "multi-page site", "small website", "a few pages"],

  questions: [
    { key: "subject", ask: "What's the site for?" },
    { key: "vibe", ask: "What vibe should it have?" },
  ],

  // The overall goal. Every step is given this before its own instructions
  // (stepSpec in lib/builder.js), so it is the one place the subject, the tone
  // and the shape of the site are stated.
  systemPrompt: (params) =>
    [
      `Build a small marketing site for ${params.subject}.`,
      `The visual tone should be ${params.vibe}.`,
      "",
      "The site is three or four pages of plain HTML in the current directory:",
      "index.html as the front door, plus the pages the subject actually needs —",
      "typically something like about.html, pricing.html or contact.html. Choose",
      "the set that suits the subject rather than filling a template.",
      "",
      "It should look like a designer made it, not like a template.",
      "",
      CRAFT,
    ].join("\n"),

  allowedTools: ["Write", "Edit", "Read"],

  // Design reference lookups when available; the site still builds without it.
  mcp: ["refero"],

  outputContract: "index.html",

  doneLine: (params) => `Your marketing site for ${params.subject} is ready, sir.`,

  startLine: (params) => `Starting on the ${params.subject} site now, sir. This one takes a while.`,

  // Three sessions rather than one, so the ceiling is roughly three times
  // landing-page's. The shares below sum to 840 seconds, leaving a minute of
  // slack for process startup — which is charged to the budget too.
  timeoutMs: 900000,

  steps: [
    {
      id: "plan",
      // Write only. A planning step with Edit or Read could start building the
      // thing it is supposed to be describing, and then the build step inherits
      // half-finished work it was never told about.
      systemPrompt: () =>
        [
          "This is the planning step. Do not write any HTML.",
          "",
          "Write a file named plan.md in the current directory containing:",
          "- the list of pages, each with its exact filename and one line on its purpose",
          "- the palette, as named roles with hex values (background, surface, ink,",
          "  muted ink, accent) and the reasoning for the choice in one sentence",
          "- the type scale, as the actual sizes and weights for h1, h2, h3 and body",
          "- the shared header and footer, described precisely enough to reproduce",
          "- the section-by-section outline of each page, with real headings, not",
          "  placeholders",
          "",
          "Be specific and decide things. A plan that says \"a suitable color scheme\"",
          "is a plan that leaves the decision to the next step, which is the one",
          "thing this step exists to prevent.",
          "",
          "Write plan.md, then stop.",
        ].join("\n"),
      allowedTools: ["Write"],
      outputContract: "plan.md",
      timeoutShareMs: 120000,
    },

    {
      id: "build-pages",
      systemPrompt: (params) =>
        [
          `This is the build step. Read the plan at ${params.previous.artifact} first`,
          "and follow it exactly: the pages it lists, the palette it chose, the type",
          "scale it set. It is not a suggestion, and this is not the moment to",
          "redesign it.",
          "",
          "Write every page the plan lists, in the current directory. index.html is",
          "the front door and must exist. Every page carries the same header and",
          "footer, and every link between them is a relative href to a file you",
          "actually wrote.",
          "",
          "Write the files, then stop. Do not explain the code afterwards.",
        ].join("\n"),
      allowedTools: ["Write", "Edit", "Read"],
      outputContract: "index.html",
      timeoutShareMs: 540000,
    },

    {
      id: "verify",
      // Read first, and Edit before Write: this step fixes pages in place. It
      // holds Write because a plan that named a page the build step never got to
      // leaves a dead link, and writing the missing page is the honest fix.
      systemPrompt: (params) =>
        [
          "This is the verification pass. The site is already written; your job is",
          `to check it against the plan at ${params.previous.dir}/plan.md and fix`,
          "what is wrong, in place.",
          "",
          "Check, in this order:",
          "- every href between pages resolves to a file that exists in this",
          "  directory. A dead link is the failure a visitor hits first.",
          "- every page the plan lists was actually written. Write any that are",
          "  missing, in the style of the ones that exist.",
          "- the palette and type scale are the same on every page.",
          "- no page contains lorem ipsum, a placeholder heading, a bracketed TODO,",
          "  or a reference to an external asset.",
          "- index.html still opens cleanly and links onward.",
          "",
          "Fix what you find by editing the files. Do not rewrite pages that are",
          "already right, and do not redesign anything. Leave index.html in place",
          "and working, then stop.",
        ].join("\n"),
      allowedTools: ["Read", "Edit", "Write"],
      // Deliberately the same file the primitive promises: the last step of a
      // chain has to, or the build's success would be decided by a file no step
      // was responsible for. See the note at the top about what that costs.
      outputContract: "index.html",
      timeoutShareMs: 180000,
    },
  ],
};
