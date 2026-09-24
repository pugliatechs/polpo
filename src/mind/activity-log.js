/**
 * Verbose activity log for the agents the mind observes.
 *
 * Every line names the agent the same way: type, short id, origin and
 * project, e.g.
 *
 *   Agent added   claude c5005793 [session] docs
 *   Agent busy    claude c5005793 [session] docs
 *   Agent idle    claude c5005793 [session] docs (busy 1m24s)
 *   Agent removed claude c5005793 [session] docs (alive 3m02s)
 *
 * What this replaced, and why:
 *
 * - The label was the session's first prompt. That put whatever the user
 *   typed (client names, business context) into a log that gets saved to
 *   files and pasted around. No prompt text is logged now; the short id
 *   is enough to find the session in the dashboard.
 * - 'added' and 'busy' used the prompt while 'removed' used a bare UUID,
 *   so the lines for one agent could not be matched up.
 * - The world model re-emits 'busy' on activity, not only on a change, so
 *   one run printed a string of identical busy lines. Only transitions
 *   are logged now.
 */

/**
 * Where an instance came from, from its origin tag.
 * @param {?string} source
 * @returns {string}
 */
function originOf(source) {
  if (typeof source !== 'string' || !source) return 'session';
  if (source.indexOf('mind:') === 0) return 'mind arm';
  if (source.indexOf('gateway:') === 0) {
    return 'gateway ' + (source.slice('gateway:'.length) || 'unknown');
  }
  return source;
}

/**
 * A prompt-free, stable label for one agent.
 * @param {object} inst - instance snapshot ({id, agentType, source, project})
 * @returns {string}
 */
function labelFor(inst) {
  if (!inst) return 'unknown';
  const type = inst.agentType || 'agent';
  const shortId = String(inst.id || '').slice(0, 8) || '????????';
  const project = inst.project ? ' ' + inst.project : '';
  return type + ' ' + shortId + ' [' + originOf(inst.source) + ']' + project;
}

/**
 * Human duration: 42s, 1m24s, 2h05m.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

/**
 * Subscribe to a WorldModel and log agent transitions.
 *
 * @param {object} opts
 * @param {EventEmitter} opts.worldModel
 * @param {object} opts.instanceManager - to look up instances by id
 * @param {{info: function}} opts.log
 * @param {function(): number} [opts.now] - injectable clock, for tests
 * @returns {function(): void} detach
 */
function attachActivityLog(opts) {
  const worldModel = opts.worldModel;
  const instanceManager = opts.instanceManager;
  const log = opts.log;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  // id -> { label, status, addedAt, busySince }
  const seen = new Map();
  // 'all:idle' fires on every idle event while nothing is busy; log it
  // once per quiet period, re-armed by the next agent going busy.
  let allIdleLogged = false;

  function track(id) {
    let entry = seen.get(id);
    if (!entry) {
      // First sighting may not be an 'added' event: agents that were
      // already registered when the mind started only ever show up as
      // status changes.
      const inst = instanceManager && typeof instanceManager.get === 'function'
        ? instanceManager.get(id)
        : null;
      entry = {
        label: labelFor(inst || { id: id }),
        status: null,
        addedAt: now(),
        busySince: null,
      };
      seen.set(id, entry);
    }
    return entry;
  }

  const onAdded = (data) => {
    const inst = (instanceManager && instanceManager.get(data.id)) || data;
    const entry = { label: labelFor(inst), status: null, addedAt: now(), busySince: null };
    seen.set(data.id, entry);
    log.info('Agent added   ' + entry.label);
  };

  const onBusy = (data) => {
    const entry = track(data.id);
    if (entry.status === 'busy') return; // not a transition
    entry.status = 'busy';
    entry.busySince = now();
    allIdleLogged = false;
    log.info('Agent busy    ' + entry.label);
  };

  const onIdle = (data) => {
    const entry = track(data.id);
    if (entry.status === 'idle') return;
    const took = entry.busySince !== null ? ' (busy ' + formatDuration(now() - entry.busySince) + ')' : '';
    entry.status = 'idle';
    entry.busySince = null;
    log.info('Agent idle    ' + entry.label + took);
  };

  const onRemoved = (data) => {
    const entry = seen.get(data.id) || track(data.id);
    seen.delete(data.id);
    log.info('Agent removed ' + entry.label + ' (alive ' + formatDuration(now() - entry.addedAt) + ')');
  };

  const onAllIdle = () => {
    if (allIdleLogged) return;
    allIdleLogged = true;
    log.info('All agents idle');
  };

  worldModel.on('agent:added', onAdded);
  worldModel.on('agent:busy', onBusy);
  worldModel.on('agent:idle', onIdle);
  worldModel.on('agent:removed', onRemoved);
  worldModel.on('all:idle', onAllIdle);

  return function detach() {
    worldModel.removeListener('agent:added', onAdded);
    worldModel.removeListener('agent:busy', onBusy);
    worldModel.removeListener('agent:idle', onIdle);
    worldModel.removeListener('agent:removed', onRemoved);
    worldModel.removeListener('all:idle', onAllIdle);
    seen.clear();
  };
}

module.exports = { attachActivityLog, labelFor, originOf, formatDuration };
