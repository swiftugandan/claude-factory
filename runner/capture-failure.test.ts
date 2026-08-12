import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "capture-failure.sh");

type Entry = {
  status: string;
  event: string;
  tool: string;
  tool_use_id: string | null;
  target: string | null;
  error: string;
};

/** Runs the hook against one payload in an isolated project dir; returns the ledger. */
function runHook(payload: unknown): Entry[] {
  const root = mkdtempSync(join(tmpdir(), "factory-capture-"));
  try {
    execFileSync("bash", [HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });

    const ledger = join(root, ".claude", "factory", "failures.jsonl");
    if (!existsSync(ledger)) return [];

    return readFileSync(ledger, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Entry);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// This is the payload Claude Code actually produces for a failed Bash call: the
// response is a STRING beginning "Error: Exit code N", not an object with a flag.
const FAILED_BASH = {
  session_id: "s1",
  hook_event_name: "PostToolUseFailure",
  tool_name: "Bash",
  tool_use_id: "toolu_01ABC",
  cwd: "/repo",
  tool_input: { command: "ls missing-path" },
  tool_response: "Error: Exit code 1\nls: missing-path: No such file or directory",
};

test("a failed Bash call is recorded from PostToolUseFailure", () => {
  const entries = runHook(FAILED_BASH);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "tool_failure");
  assert.equal(entries[0].event, "PostToolUseFailure");
  assert.equal(entries[0].tool, "Bash");
  assert.equal(entries[0].tool_use_id, "toolu_01ABC");
  // The invocation is recorded so a reader can reproduce it without the transcript.
  assert.equal(entries[0].target, "ls missing-path");
  assert.match(entries[0].error, /No such file or directory/);
});

test("PostToolUseFailure is trusted regardless of the response shape", () => {
  // The event itself is the signal. Sniffing here would let an unfamiliar payload
  // discard a real failure — which is how the ledger came to be empty before.
  for (const response of [
    { stdout: "", stderr: "boom", interrupted: false },
    "something that does not begin with the word Error",
    null,
  ]) {
    const entries = runHook({ ...FAILED_BASH, tool_response: response });
    assert.equal(entries.length, 1, `expected a ledger entry for ${JSON.stringify(response)}`);
  }
});

test("a blocked write is recorded", () => {
  const entries = runHook({
    session_id: "s1",
    hook_event_name: "PostToolUseFailure",
    tool_name: "Write",
    tool_use_id: "toolu_02",
    tool_input: { file_path: "/repo/.env.example" },
    tool_response: "Error: PreToolUse:Write hook error: Blocked: protected path",
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].target, "/repo/.env.example");
});

test("a successful PostToolUse call is not recorded", () => {
  const entries = runHook({
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_03",
    tool_input: { command: "echo hi" },
    tool_response: "hi",
  });

  assert.equal(entries.length, 0);
});

test("PostToolUse still records an in-band error, since some tools report one while succeeding", () => {
  const flagged = runHook({
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_use_id: "toolu_04",
    tool_input: { file_path: "/repo/a.ts" },
    tool_response: { is_error: true, error: "String to replace not found" },
  });
  assert.equal(flagged.length, 1);

  const stringy = runHook({
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_05",
    tool_input: { command: "run" },
    tool_response: "Error: something went wrong",
  });
  assert.equal(stringy.length, 1);
});

// The root cause was registration, not detection: PostToolUse fires only after a call
// SUCCEEDS, so a hook registered there alone can never see a failure. These two tests
// guard the wiring in both the plugin manifest and the vendored template, because a
// perfect script registered on the wrong event records nothing.
for (const [label, manifest] of [
  ["plugin manifest", join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "hooks.json")],
  [
    "vendored template",
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "templates",
      "settings.vendored-hooks.json",
    ),
  ],
] as const) {
  test(`${label} registers capture-failure on PostToolUseFailure`, () => {
    const config = JSON.parse(readFileSync(manifest, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };

    const registered = (event: string) =>
      (config.hooks[event] ?? []).some((entry) =>
        entry.hooks.some((hook) => hook.command.includes("capture-failure.sh")),
      );

    assert.ok(registered("PostToolUseFailure"), "missing on PostToolUseFailure");
    assert.ok(registered("PostToolUse"), "missing on PostToolUse");
  });
}

test("the hook never blocks, whatever it is handed", () => {
  // Observational only: a malformed payload must not fail the tool call.
  for (const payload of [{}, { hook_event_name: "PostToolUse" }, { tool_response: 42 }]) {
    assert.doesNotThrow(() => runHook(payload));
  }
});
