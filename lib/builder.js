import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { buildSucceeded, parseResultEvent } from "./outcome.js";
import { progressLines } from "./progress.js";

// The only module that runs Claude with tools ON. Everything else in this repo
// asks questions; this one hands a fresh directory to a model and lets it write.
// That makes it the module worth being paranoid about: least-privilege tools, a
// hard timeout, a raw log on disk, and a failure that is an outcome rather than
// a crash.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

// GOTCHA: hooks fire inside the spawned build too, not just the chat session.
// So a Stop hook configured globally on this machine — one that speaks whatever
// Claude just said, for instance — would narrate the build out loud over the top
// of the assistant. Turning hooks off for the build is what keeps one voice in
// the room. Same settings file the chat brain uses; the deny rules below are
// merged onto it per build.
const SETTINGS = join(REPO, "claude-settings.json");

// The real instructions live in --append-system-prompt. The positional prompt
// only has to start the turn, so it stays short and content-free.
const KICK = "Begin. Follow the instructions in your system prompt exactly, then stop.";

// Pinned rather than inherited. Two reasons, one of which is a real failure:
// the settings file above turns thinking off, and the API rejects the highest
// effort levels outright when thinking is disabled — so a machine whose global
// config asks for maximum effort would fail EVERY build with a 400 before any
// work happened. Beyond that, a build should behave the same for everyone
// rather than tracking whatever the operator tuned their own editor to.
const EFFORT = "high";

// How long a build gets to shut down politely after SIGTERM before it is killed.
const KILL_GRACE_MS = 2000;

// --allowedTools only widens what runs WITHOUT a prompt; on its own it takes
// nothing away. Measured on claude 2.1.220: a build spawned with
// --allowedTools "Write Edit Read" still ran a shell command through Bash and
// reported permission_denials: [] — so a primitive's tool list, read as a
// sandbox, is not one. The tools that let a build leave its own directory are
// therefore denied by name, which does remove them from the session entirely.
// A primitive that genuinely needs one gets it back by listing it in
// allowedTools; this is a floor, not a ceiling.
const REACHES_OUTSIDE = ["Bash", "BashOutput", "KillShell", "Task", "WebFetch", "WebSearch"];

// POSIX only: a negative pid signals a whole process group, and `detached` is
// what puts the child in a group of its own. Windows has neither.
const OWN_PROCESS_GROUP = process.platform !== "win32";

// ---------------------------------------------------------------------------
// Pure: where a build is not allowed to write
// ---------------------------------------------------------------------------

// Giving a build its own directory to work in is NOT a sandbox. Write and Edit
// accept absolute paths, so the working directory contains nothing on its own:
// a build that took its instructions too literally, or one that read a hostile
// instruction out of a file it was pointed at, can write anywhere the person
// running it can write. Measured on claude 2.1.220: a build spawned with
// --allowedTools "Write Edit Read" wrote a file well outside its own directory
// and still reported permission_denials: [].
//
// `permissions.deny` in the settings file is the layer that actually refuses —
// same measurement, the write came back as "File is in a directory that is
// denied by your permission settings" — so that is where this is enforced,
// rather than in a prompt the model is free to reinterpret.
//
// Deny beats allow, which is exactly why the list below is targeted instead of
// "everything under the home directory": the build's own output folder lives
// under the home directory too, and a blanket rule would refuse the build
// itself. What is listed is the narrow set of places where a written file turns
// into code that later runs, into credentials, or into this app's own source.

// Startup files a login shell reads. A line appended to any of them runs the
// next time a terminal is opened.
const SHELL_RC_FILES = [
  ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout",
  ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile",
];

// Every built-in tool that can put bytes on disk. Listed one by one because a
// permission rule is matched against a single tool name.
const WRITING_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

// Directories whose contents are read back as configuration or credentials by
// something other than this build.
function deniedDirs(home, repo) {
  return [
    join(home, ".claude"), // hooks live here: a file written here is code that runs on the next claude session
    join(home, ".ssh"),
    join(home, ".gnupg"),
    join(home, ".aws"),
    join(home, ".config"), // shells, launchers and CLIs read their startup config from here
    join(home, ".local", "bin"), // early on most PATHs, so a file here shadows real commands
    join(home, "bin"), // the other conventional personal bin dir, same PATH risk
    join(home, ".codex"), // other coding agents keep executable config here too
    join(home, "Library", "Application Support"), // app config and launch data
    join(home, "Library", "LaunchAgents"), // macOS: a plist here runs at the next login
    join(home, "Library", "LaunchDaemons"),
    "/Library/LaunchAgents",
    "/Library/LaunchDaemons",
    "/etc",
    // This app's own source. A build must not be able to rewrite the program
    // that is running it and serving what it wrote.
    join(repo, "lib"),
    join(repo, "public"),
    join(repo, "primitives"),
    join(repo, "node_modules"),
  ];
}

// Single files that matter as much as the directories above.
function deniedFiles(home, repo) {
  return [
    join(home, ".claude.json"), // MCP server definitions: a command line that runs on the next session
    join(home, ".npmrc"),
    join(home, ".gitconfig"), // an alias or a pager entry is a command that runs on the next git call
    ...SHELL_RC_FILES.map((name) => join(home, name)),
    join(repo, "server.js"),
    join(repo, "package.json"),
    join(repo, "claude-settings.json"),
  ];
}

// An absolute path in a permission rule needs the `//` prefix. A single leading
// slash is read as a path relative to the settings file's own directory, so the
// rule would look right and match nothing.
function rulePath(absolute) {
  return `//${absolute.replace(/^\/+/, "")}`;
}

// denyRules({ home?, repo? }) -> the permission rules for one build.
// Pure and exported so the list can be read and tested without spawning
// anything: it is the difference between a build being contained and not.
export function denyRules(opts = {}) {
  const home = opts.home ?? homedir();
  const repo = opts.repo ?? REPO;

  const noWrite = [
    ...deniedDirs(home, repo).map((dir) => `${dir}/**`),
    ...deniedFiles(home, repo),
    // Not anchored to a directory: a hook written into ANY repository on this
    // machine runs the next time someone commits there.
    "**/.git/hooks/**",
  ];
  const rules = noWrite.flatMap((target) =>
    WRITING_TOOLS.map((tool) => `${tool}(${rulePath(target)})`),
  );

  // Reading is denied for secrets only. A build's output is HTML that gets
  // opened in a browser and its narration is streamed back to a page, so a
  // private key it read is a private key that can leave the machine.
  for (const dir of [join(home, ".ssh"), join(home, ".gnupg"), join(home, ".aws")]) {
    rules.push(`Read(${rulePath(`${dir}/**`)})`);
  }
  rules.push(`Read(${rulePath(join(home, ".claude.json"))})`);

  return rules;
}

// The shared settings file is what turns hooks and thinking off. If it cannot be
// read, a build still has to run with hooks off rather than inherit whatever the
// machine is configured to do, so the fallback is that same intent in code.
function readSharedSettings(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Falls through to the safe default below.
  }
  return { disableAllHooks: true, alwaysThinkingEnabled: false };
}

// Merge, never replace: whatever the shared file already denies stays denied.
export function buildSettings(base, rules) {
  const permissions = base.permissions && typeof base.permissions === "object"
    ? base.permissions
    : {};
  const existing = Array.isArray(permissions.deny) ? permissions.deny : [];
  return { ...base, permissions: { ...permissions, deny: [...existing, ...rules] } };
}

// The rules name absolute paths, so they cannot ship in the repo's settings
// file: they are only knowable on the machine the build runs on. Written to a
// temp directory rather than into the build's own folder, because a policy file
// the build can overwrite is not a policy, and because the build folder is
// served over HTTP.
async function writeBuildSettings(opts) {
  const dir = await mkdtemp(join(tmpdir(), "dante-build-"));
  const path = join(dir, "settings.json");
  const base = readSharedSettings(opts.sharedSettings ?? SETTINGS);
  await writeFile(path, JSON.stringify(buildSettings(base, denyRules(opts)), null, 2));
  return { path, dir };
}

// ---------------------------------------------------------------------------
// Pure: the command line
// ---------------------------------------------------------------------------

function toNameSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

// A primitive's `mcp` list is a list of OPTIONAL slots. A build must never
// hard-depend on an MCP server the person running it has not installed, so an
// unconfigured slot is skipped in silence rather than granted or announced.
//
// The spawned CLI already inherits the user's own MCP configuration; what it
// does NOT inherit is permission to call it, because --allowedTools is an
// explicit allowlist. `mcp__<server>` is the pattern that grants every tool on
// one server, so a configured slot contributes exactly that one token.
function grantedMcpTools(primitive, opts) {
  const configured = toNameSet(opts.mcpServers);
  return (primitive.mcp ?? [])
    .filter((name) => configured.has(name))
    .map((name) => `mcp__${name}`);
}

// Synchronous and side-effect free on purpose: the command line is the part most
// likely to be wrong and the part hardest to debug once a subprocess is running,
// so it is testable on its own without spawning anything.
export function buildSpawnArgs(primitive, params, opts = {}) {
  const systemPrompt = primitive.systemPrompt(params);
  const tools = [...(primitive.allowedTools ?? []), ...grantedMcpTools(primitive, opts)];

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose", // stream-json refuses to stream without it
    "--permission-mode", "acceptEdits", // unattended: nobody is here to click "allow"
    "--settings", opts.settings ?? SETTINGS,
  ];

  // Opt out with `effort: ""` if a future CLI drops the flag.
  const effort = opts.effort ?? EFFORT;
  if (effort) args.push("--effort", effort);

  args.push("--append-system-prompt", systemPrompt);

  // Everything the primitive did not ask for and that could reach past this
  // build's own directory. Listed before --allowedTools purely for readability:
  // both flags are variadic and each stops at the next token beginning with "-".
  const denied = REACHES_OUTSIDE.filter((name) => !tools.includes(name));
  if (denied.length > 0) args.push("--disallowedTools", ...denied);

  // Kept last of the flags because --allowedTools is variadic: every following
  // token is read as a tool name until the options terminator stops it.
  if (tools.length > 0) args.push("--allowedTools", ...tools);

  // Without `--`, the kick prompt would be swallowed as one more tool name.
  args.push("--", opts.kick ?? KICK);
  return args;
}

// stepSpec(primitive, step) -> something buildSpawnArgs can read as a primitive.
//
// A small adapter rather than a second code path, so the command line is still
// built by exactly one function. Three rules, and the middle one is the point:
//
// - the primitive's own prompt goes FIRST, because a step that has been told to
//   write plan.md but not what the build is for will write a plan about nothing;
// - `allowedTools` is the step's, always. Falling back to the primitive's would
//   quietly hand a planning step the write tools the building step needs, which
//   is the kind of grant nobody notices until it is used;
// - `mcp` IS inherited, but only when the step names none of its own. MCP slots
//   are optional capability, not authority: an unconfigured one is skipped
//   anyway (grantedMcpTools above).
export function stepSpec(primitive, step) {
  return {
    systemPrompt: (params) => `${primitive.systemPrompt(params)}\n\n${step.systemPrompt(params)}`,
    allowedTools: step.allowedTools,
    mcp: step.mcp && step.mcp.length > 0 ? step.mcp : (primitive.mcp ?? []),
  };
}

// Which MCP servers exist on THIS machine, read from the user-scope config the
// CLI itself uses. Best-effort by design: an unreadable or reshaped config means
// "no optional slots available", which degrades a build rather than breaking it.
export function configuredMcpServers(opts = {}) {
  const path = opts.configPath ?? join(opts.home ?? homedir(), ".claude.json");
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    const servers = config?.mcpServers;
    return servers && typeof servers === "object" ? Object.keys(servers) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Impure: the pieces a running build is made of
// ---------------------------------------------------------------------------

// stdout arrives in pipe-sized chunks that split JSON objects mid-line, so lines
// have to be reassembled before anything can parse them. This is done here
// rather than with progress.js's stream helper because the same raw lines feed
// two consumers: the human progress text AND the terminal `result` event.
function lineSplitter() {
  let carry = "";
  const decoder = new StringDecoder("utf8"); // holds bytes of a character split across chunks
  return {
    push(chunk) {
      const parts = (carry + decoder.write(chunk)).split("\n");
      carry = parts.pop() ?? ""; // no trailing newline yet: wait for the rest
      return parts;
    },
    flush() {
      const last = carry + decoder.end();
      carry = "";
      return last === "" ? [] : [last];
    },
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// A build owns its directory outright — the output contract is "this file exists
// here afterwards", which only means anything if nothing else wrote here first.
// Two builds started in the same millisecond would otherwise share a folder.
async function freshBuildDir(root) {
  await mkdir(root, { recursive: true });
  const base = timestamp();
  for (let attempt = 1; ; attempt++) {
    const dir = join(root, attempt === 1 ? base : `${base}-${attempt}`);
    try {
      await mkdir(dir); // non-recursive: fails loudly if the name is taken
      return dir;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

// A progress callback is UI code. It runs on someone else's socket, and a build
// that has been running for two minutes must not die because a HUD update threw.
function safely(onProgress, line) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(line);
  } catch {
    // Reporting is best-effort; the build is the thing that matters.
  }
}

// A build can start processes of its own — an MCP server, a language server —
// and killing only the process we spawned leaves those running with nobody
// waiting on them. Signalling the group reaches the whole tree. Falls back to
// the single child where there is no group to signal, and treats "already gone"
// as the outcome it wanted.
function signalBuild(child, signal) {
  try {
    if (OWN_PROCESS_GROUP && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Nothing left to signal.
    }
  }
}

function closeLog(stream) {
  return new Promise((done) => {
    if (stream.destroyed) return done();
    stream.once("close", done); // fires whether the stream ended cleanly or errored
    stream.end();
  });
}

// A log that opens on its first byte. The stream cannot simply be created up
// front: a CLI that is not installed produces nothing at all, and an empty
// build.log left in the directory reads as "the build ran and said nothing",
// which is the one thing that did not happen. Opening late also means one log
// can be shared by a chain of invocations without any of them owning it — the
// build opens it, run() closes it once, in a finally.
function openLogLater(path) {
  let stream = null;
  return {
    write(chunk) {
      if (!stream) {
        stream = createWriteStream(path);
        stream.on("error", () => {
          // A log we cannot write is not a reason to abandon a running build.
        });
      }
      stream.write(chunk);
    },
    close() {
      return stream ? closeLog(stream) : Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Impure: one invocation of the CLI
// ---------------------------------------------------------------------------

// spawnClaude(ctx) -> { code, result, timedOut }
//
// The only place in this module where a child process exists, so everything
// about killing one, reassembling its output and getting its log onto disk is
// here and nowhere else. It knows nothing about primitives, directories or
// output contracts: it is handed a command line and a place to run it, and it
// reports what came back. Rejects only when the CLI cannot be started at all.
//
// `ctx.step` is the name of the step this invocation belongs to, and travels
// out on every progress envelope. A build that is not made of steps passes ""
// — the readout renders those exactly as it always did.
function spawnClaude(ctx) {
  return new Promise((resolvePromise, reject) => {
    // GOTCHA: stdin must be closed explicitly. Left inheriting the parent's, the
    // CLI waits several seconds for input that is never coming.
    const child = spawn(ctx.bin ?? "claude", ctx.args, {
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout can take down everything the build
      // started rather than just the process we can see. The side effect is
      // wanted too: a Ctrl-C in the terminal no longer reaches a build halfway
      // through writing a file.
      detached: OWN_PROCESS_GROUP,
    });

    const splitter = lineSplitter();
    const step = ctx.step ?? "";
    let result = null;
    let timedOut = false;
    let exited = false;

    const handleLine = (line) => {
      for (const text of progressLines(line)) {
        safely(ctx.onProgress, { kind: "line", step, text });
      }
      // The last result event wins; there is normally exactly one, at the end.
      result = parseResultEvent(line) ?? result;
    };

    child.stdout.on("data", (chunk) => {
      ctx.log.write(chunk);
      for (const line of splitter.push(chunk)) handleLine(line);
    });
    // stderr goes to the same file so the log reads in the order things happened.
    child.stderr.on("data", (chunk) => ctx.log.write(chunk));

    let killTimer = null;
    const graceMs = ctx.killGraceMs ?? KILL_GRACE_MS;
    const deadline = Number.isFinite(ctx.timeoutMs) && ctx.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          signalBuild(child, "SIGTERM"); // ask first: a polite exit still flushes the log
          killTimer = setTimeout(() => {
            // A build that ignores SIGTERM does not get to outlive us, and
            // neither does anything it started.
            if (!exited) signalBuild(child, "SIGKILL");
          }, graceMs);
          killTimer.unref(); // never hold the process open just to schedule a kill
        }, ctx.timeoutMs)
      : null;

    const clearTimers = () => {
      if (deadline) clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
    };

    // Node emits BOTH "error" and "close" when the CLI cannot be started at all,
    // and both handlers below finish their cleanup asynchronously. Without a flag
    // set synchronously here, the two chains race: about a third of the time
    // "close" wins and a missing CLI is reported as an ordinary failed build --
    // so the person is told the build stopped early, and the ENOENT the
    // troubleshooting steps tell them to look for never reaches the log.
    // Settling this promise is now what claims the outcome, but the flag stays:
    // it is also what stops the flush below from reporting progress lines for a
    // process that never ran.
    let spawnFailed = false;

    child.on("error", (err) => {
      exited = true;
      spawnFailed = true; // synchronous: claims the outcome before any await
      clearTimers();
      reject(err); // e.g. ENOENT: the CLI is not installed
    });

    child.on("close", (code) => {
      exited = true;
      clearTimers();
      if (spawnFailed) return; // the error handler owns this outcome

      for (const line of splitter.flush()) handleLine(line); // the final line often has no newline
      resolvePromise({ code, result, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Impure: running the build
// ---------------------------------------------------------------------------

// One invocation, one output contract — what every primitive does today.
async function runSingleShot(primitive, params, ctx) {
  const args = buildSpawnArgs(primitive, params, ctx.spawnOpts);
  const { code, result, timedOut } = await spawnClaude({ ...ctx, args, step: "" });

  const ok = buildSucceeded({
    code,
    dir: ctx.cwd,
    outputContract: primitive.outputContract,
    result,
  });
  return {
    ok,
    // Only claimed on success, where the contract has been checked to be a
    // real file inside this build's own directory.
    artifact: ok ? resolve(ctx.cwd, primitive.outputContract) : null,
    result,
    timedOut,
  };
}

// One invocation per step, in order, all in the same directory.
//
// COLD SESSION PER STEP, deliberately — this will be questioned, so: the state a
// step needs from the one before it already has a channel, which is the shared
// directory. The next step's prompt names the file the last one wrote and reads
// it back off disk. --resume would thread a session id out of spawnClaude, drag
// a planning transcript into a nine-minute HTML step, and put session state into
// buildSpawnArgs — the one function this module deliberately keeps pure. The
// re-read is not a workaround either: a verify step that reads index.html from
// disk is verifying, where one recalling it from its own context is remembering.
async function runSteps(primitive, params, ctx) {
  const ceiling = primitive.timeoutMs;
  const of = primitive.steps.length;
  let spent = 0;
  let result = null;
  let timedOut = false;

  // Always an object, never null, including on the very first step. A step's
  // systemPrompt is called synchronously inside buildSpawnArgs, so a null here
  // turns a typo in someone's primitive into an unexplained TypeError that
  // rejects the whole build instead of failing it.
  let previous = { dir: ctx.cwd, id: null, artifact: null };

  for (const [index, step] of primitive.steps.entries()) {
    const remaining = ceiling - spent;
    if (remaining <= 0) {
      // Starting it could only overrun further, and a step killed on its first
      // second produces nothing but a confusing log.
      return { ok: false, artifact: null, result, timedOut: true, failedStep: step.id };
    }

    // A boundary in the same log the steps stream into. Cheap, and the
    // difference between a combined 900-second log and a readable one.
    ctx.log.write(`\n=== step: ${step.id} ===\n`);
    safely(ctx.onProgress, { kind: "step", step: step.id, state: "start", index, of });

    const args = buildSpawnArgs(stepSpec(primitive, step), { ...params, previous }, ctx.spawnOpts);

    // The wall clock, not the share: process startup and the log flush are time
    // the build really took, and charging only the spawn's own deadline would
    // let a long chain drift past its ceiling a little at a time.
    const startedAt = Date.now();
    const outcome = await spawnClaude({
      ...ctx,
      args,
      step: step.id,
      timeoutMs: Math.min(step.timeoutShareMs ?? remaining, remaining),
    });
    spent += Date.now() - startedAt;

    result = outcome.result ?? result;
    timedOut = timedOut || outcome.timedOut;

    // buildSucceeded, not a bare existence check: a step can write its file and
    // still report an error, and the single-shot path has always caught that.
    const stepOk = buildSucceeded({
      code: outcome.code,
      dir: ctx.cwd,
      outputContract: step.outputContract,
      result: outcome.result,
    });
    if (!stepOk) return { ok: false, artifact: null, result, timedOut, failedStep: step.id };

    previous = { dir: ctx.cwd, id: step.id, artifact: resolve(ctx.cwd, step.outputContract) };
  }

  // The chain's own promise, checked the same way a single-shot build's is. The
  // registry makes the last step's contract equal this one, but run() can be
  // called with a primitive that never went through it.
  const last = primitive.steps[of - 1];
  const ok = buildSucceeded({
    code: 0,
    dir: ctx.cwd,
    outputContract: primitive.outputContract,
    result,
  });
  return {
    ok,
    artifact: ok ? resolve(ctx.cwd, primitive.outputContract) : null,
    result,
    timedOut,
    failedStep: ok ? null : last.id,
  };
}

// run(primitive, params, onProgress?, opts?) -> { ok, dir, artifact, result, log, timedOut }
//
// Resolves for every finished build, successful or not: a failed build is an
// answer the assistant has to speak, not an exception to unwind. The one thing
// that rejects is being unable to start the CLI at all.
//
// One directory, one log and one settings file per build, however many times the
// CLI is invoked inside it. The settings file in particular: regenerating it per
// invocation would leave a later one running under the machine's default policy
// the moment an earlier one cleaned it up.
export async function run(primitive, params, onProgress, opts = {}) {
  const dir = await freshBuildDir(opts.root ?? join(REPO, "builds"));
  const logPath = join(dir, "build.log");
  const log = openLogLater(logPath);
  // A caller that supplies its own settings file owns the whole policy; with no
  // such file, the shared one is merged with this machine's deny list into a
  // throwaway file that lives exactly as long as the build.
  const generated = opts.settings ? null : await writeBuildSettings(opts);

  const ctx = {
    bin: opts.bin,
    cwd: dir,
    log,
    onProgress,
    timeoutMs: primitive.timeoutMs,
    killGraceMs: opts.killGraceMs,
    spawnOpts: {
      ...opts,
      settings: opts.settings ?? generated.path,
      mcpServers: opts.mcpServers ?? configuredMcpServers(),
    },
  };

  let outcome;
  try {
    outcome = primitive.steps
      ? await runSteps(primitive, params, ctx)
      : await runSingleShot(primitive, params, ctx);
  } finally {
    await log.close(); // resolve only once the log is complete on disk
    if (generated) await rm(generated.dir, { recursive: true, force: true }).catch(() => {});
  }

  // Deliberately outside the try: `return x` evaluates x BEFORE the finally
  // runs, so asking whether the log exists from in there would stat a file the
  // stream has not finished closing.
  return { ...outcome, dir, log: existsSync(logPath) ? logPath : null };
}
