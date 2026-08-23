#!/usr/bin/env bash
# Project-scoped SessionStart hook.
#
# The superpowers plugin injects its `using-superpowers` skill at session start
# with instructions that a matching skill MUST be invoked before any response,
# including clarifying questions. That directly contradicts this harness's own
# rules against spawning agents or entering workflows the user did not ask for.
# Two always-present instruction sets, one of which is designed to lose, is
# roughly 700 tokens per turn of guaranteed dead weight.
#
# This hook does not disable superpowers. It downgrades "must invoke" to
# "recommend, then let the user decide" — which is the behaviour superpowers'
# own text already sanctions ("User instructions ... take precedence over
# skills"). Suggestions still surface; nothing is auto-invoked.
#
# Lives here rather than in the plugin cache on purpose: editing
# ~/.claude/plugins/cache/superpowers-dev/.../using-superpowers/SKILL.md would
# be reverted by the next plugin update, without warning.

set -euo pipefail

read -r -d '' CONTEXT <<'EOF' || true
<PROJECT_OVERRIDE priority="user-instruction">
SUPERPOWERS: RECOMMEND, DO NOT AUTO-INVOKE.

The `superpowers:using-superpowers` text injected earlier in this session says you
MUST invoke any skill that might apply before responding. In this repository that
is downgraded to a recommendation, by explicit user instruction. That skill's own
"User Instructions" clause defers to this.

What this changes:
- Do NOT auto-invoke superpowers skills (brainstorming, systematic-debugging,
  test-driven-development, subagent-driven-development, executing-plans, and the
  rest) on your own initiative.
- Do NOT spawn subagents, enter multi-step workflows, or install anything unless
  the user asks for it in that turn.
- Do NOT treat "1% chance a skill applies" as a mandate to invoke it.

What to do instead:
- When a superpowers skill would genuinely help, say so in one line — name it and
  say what it would do — and carry on with the work using your own judgment. The
  user decides whether to run it.
- A skill the user names explicitly (by name or as /slash-command) is a direct
  request: invoke it as normal.

The harness rules against unrequested agent spawning and unrequested workflows
remain fully in force; this override never loosens them.
</PROJECT_OVERRIDE>
EOF

escape_for_json() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}

printf '{\n  "hookSpecificOutput": {\n    "hookEventName": "SessionStart",\n    "additionalContext": "%s"\n  }\n}\n' \
    "$(escape_for_json "$CONTEXT")"

exit 0
