// Shared impure-test fixtures — the ones CLAUDE.md's "reuse the existing
// fixtures" line points at. Every test file that spawns a real fake CLI or
// needs a real temp directory used to grow its own copy of these; they are
// collected here so there is exactly one place to fix a bug in the fixture
// itself.

import { writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// A real executable script, written to disk and spawned for real, so the
// child-process plumbing under test (argv, exit codes, signals, streams) is
// never mocked away. `preamble` lets a caller splice lines in before `body` —
// e.g. requiring `node:fs` and logging argv, or defining a shared constant —
// without every fixture having to duplicate that setup by hand.
export async function writeFakeCli(dir, name, body, { preamble = [] } = {}) {
  const path = join(dir, name);
  await writeFile(path, ["#!/usr/bin/env node", ...preamble, body].join("\n"), { mode: 0o755 });
  return path;
}

// A preamble that makes a fake CLI log its own argv, one line per invocation,
// to `logPath` — how a test counts spawns and checks what each one was asked.
export function logsArgvPreamble(logPath) {
  return [
    'const fs = require("node:fs");',
    `const LOG = ${JSON.stringify(logPath)};`,
    'fs.appendFileSync(LOG, process.argv.slice(2).join(" ") + "\\n");',
  ];
}

// fn must be synchronous: the finally block below rmSync's the directory as
// soon as fn returns, so an async fn would race its own cleanup and could
// still be reading from the directory after it is gone. withTempFiles is the
// async sibling of this, and its `return await` guard is what buys it the
// right to take one.
export function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Each temp dir gets a fresh path so dynamic import() never serves a cached
// module. `return await` is load-bearing: without it the finally block deletes
// the directory while fn is still awaiting an import, which only looks fine
// when the fixture has a single file and the loader wins the race.
export async function withTempFiles(prefix, files, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
    return await fn(pathToFileURL(dir + "/"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
