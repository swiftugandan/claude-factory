import { test } from "node:test";
import assert from "node:assert/strict";

import { renderStateComment, parseStateComment, STATE_MARKER, type RunState } from "./state.ts";

const state: RunState = {
  id: "ENG-142",
  status: "running",
  attempts: 2,
  claimed_at: "2026-08-11T09:00:00.000Z",
  claimed_by: "https://github.com/acme/app/actions/runs/1",
  cost_usd: 0.42,
};

test("state survives a render and parse round trip", () => {
  const parsed = parseStateComment(renderStateComment(state));
  assert.deepEqual(parsed, { ...state, last_run_url: undefined, last_error: undefined, updated_at: undefined });
});

test("the marker is what identifies a state comment", () => {
  assert.ok(renderStateComment(state).includes(STATE_MARKER));
  assert.equal(parseStateComment("```json\n{\"id\":\"X\"}\n```"), null);
});

test("an unparseable or foreign comment yields null rather than a fabricated state", () => {
  assert.equal(parseStateComment(""), null);
  assert.equal(parseStateComment("just a human comment"), null);
  assert.equal(parseStateComment(`${STATE_MARKER}\n\`\`\`json\nnot json\n\`\`\``), null);
  assert.equal(parseStateComment(`${STATE_MARKER}\nno fence at all`), null);
  assert.equal(parseStateComment(`${STATE_MARKER}\n\`\`\`json\n{"attempts":3}\n\`\`\``), null);
});

test("attempts default to zero, never to undefined", () => {
  // A missing attempt count that reads as undefined becomes NaN in a comparison,
  // and a NaN budget check silently permits unlimited retries.
  const parsed = parseStateComment(`${STATE_MARKER}\n\`\`\`json\n{"id":"A"}\n\`\`\``);
  assert.equal(parsed?.attempts, 0);
  assert.equal(parsed?.status, "claimed");
});
