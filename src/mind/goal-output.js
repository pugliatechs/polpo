/**
 * What a goal produced, in a shape an external caller can consume.
 *
 * Until v1.2.3 the gateway had no way to hand a caller the result of a
 * goal. goal.result was one of two fixed sentences, GET /v1/goals/:id
 * carried no task output, and the only place output appeared at all was
 * the live task_done SSE event, trimmed to its last 1000 characters. An
 * external system asking the mind for a report could not get the
 * report.
 *
 * Shared by the coordinator (for the SSE `done` event) and the gateway
 * (for the goal snapshot) so both apply the same cap and the same idea
 * of which output is the deliverable.
 */

const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;

/**
 * Per-task output cap, POLPO_GOAL_OUTPUT_MAX_CHARS or 64 KiB.
 * @returns {number}
 */
function maxOutputChars() {
  const n = Number(process.env.POLPO_GOAL_OUTPUT_MAX_CHARS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_OUTPUT_CHARS;
}

/**
 * Keep the END of the text when it is too long.
 *
 * An arm's output is everything it said during the run, narration first
 * ("let me search for..."), and its actual answer last. The tail is the
 * part worth keeping.
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {{output: string, outputTruncated: boolean}}
 */
function capTail(text, max) {
  const limit = max || maxOutputChars();
  const s = typeof text === 'string' ? text : '';
  if (s.length <= limit) return { output: s, outputTruncated: false };
  return { output: s.slice(-limit), outputTruncated: true };
}

/**
 * Tasks whose output nothing else in the plan consumes: the leaves of
 * the dependency graph. Earlier tasks feed their findings forward into
 * their dependents, so the leaves are what the goal delivers.
 *
 * @param {object} goal
 * @returns {Array<object>} completed leaf tasks, in plan order
 */
function deliverableTasks(goal) {
  const tasks = (goal && goal.plan && goal.plan.tasks) || [];
  const consumed = new Set();
  for (const t of tasks) {
    for (const dep of (t.dependsOn || [])) consumed.add(dep);
  }
  return tasks.filter((t, i) => {
    const index = typeof t.index === 'number' ? t.index : i;
    return !consumed.has(index) && t.status === 'completed' && typeof t.output === 'string' && t.output;
  });
}

/**
 * The goal's deliverable as one string. A single leaf is returned as is;
 * several are joined under their task descriptions.
 *
 * @param {object} goal
 * @returns {{finalOutput: ?string, finalOutputTruncated: boolean}}
 */
function goalFinalOutput(goal) {
  const leaves = deliverableTasks(goal);
  if (leaves.length === 0) return { finalOutput: null, finalOutputTruncated: false };
  const combined = leaves.length === 1
    ? leaves[0].output
    : leaves.map((t) => '## ' + t.description + '\n\n' + t.output).join('\n\n');
  const capped = capTail(combined);
  return { finalOutput: capped.output, finalOutputTruncated: capped.outputTruncated };
}

module.exports = {
  DEFAULT_MAX_OUTPUT_CHARS,
  maxOutputChars,
  capTail,
  deliverableTasks,
  goalFinalOutput,
};
