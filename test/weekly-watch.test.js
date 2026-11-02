'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWeeklyWatch } = require('../lib/weekly-watch');

const MONDAY_0900 = Date.parse('2026-11-02T09:00:00Z');
const quiet = { log() {}, error() {} };

function fakeGitHub(counts) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    const wf = /workflows\/([^/]+)\/runs/.exec(url)[1];
    return Response.json({ total_count: counts[wf] ?? 0 });
  };
  return { asked, fetchImpl };
}

test('weekly watch: starts a Monday workflow GitHub skipped, once, and leaves one that ran', async () => {
  const gh = fakeGitHub({ 'audit.yml': 0, 'weekly-report.yml': 1 });
  const started = [];
  let at = MONDAY_0900;
  const w = createWeeklyWatch({ token: 't', fetchImpl: gh.fetchImpl, now: () => at, log: quiet, dispatch: async (wf) => { started.push(wf); return true; } });
  assert.deepEqual(await w.tick(), ['audit.yml']);
  assert.match(gh.asked[0], /created=%3E%3D2026-11-02/);
  // Half an hour later: nothing again, even if GitHub still shows no run.
  at += 30 * 60 * 1000;
  assert.deepEqual(await w.tick(), []);
  assert.deepEqual(started, ['audit.yml']);
});

test('weekly watch: only on Mondays after the workflow time plus two hours; GitHub errors start nothing', async () => {
  const started = [];
  const dispatch = async (wf) => { started.push(wf); return true; };
  const early = createWeeklyWatch({ token: 't', fetchImpl: fakeGitHub({}).fetchImpl, now: () => Date.parse('2026-11-02T07:00:00Z'), log: quiet, dispatch });
  assert.deepEqual(early.due().map((x) => x.workflow), []);
  const tuesday = createWeeklyWatch({ token: 't', fetchImpl: fakeGitHub({}).fetchImpl, now: () => Date.parse('2026-11-03T12:00:00Z'), log: quiet, dispatch });
  assert.deepEqual(await tuesday.tick(), []);
  const broken = createWeeklyWatch({ token: 't', fetchImpl: async () => new Response('', { status: 500 }), now: () => MONDAY_0900, log: quiet, dispatch });
  assert.deepEqual(await broken.tick(), []);
  const noToken = createWeeklyWatch({ fetchImpl: fakeGitHub({}).fetchImpl, now: () => MONDAY_0900, log: quiet, dispatch });
  assert.deepEqual(await noToken.tick(), []);
  assert.deepEqual(started, []);
});
