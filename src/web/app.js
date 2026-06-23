/* ==============================
   Polpo — Mobile Web App
   ============================== */

(function () {
  'use strict';

  // ---- Auth ----
  // Clean token from URL after the server sets a session cookie
  var urlParams = new URLSearchParams(location.search);
  if (urlParams.has('token')) {
    // The server's static middleware already set the session cookie
    // on this page load. Remove the token from the URL bar for security.
    urlParams.delete('token');
    var cleanUrl = urlParams.toString()
      ? location.pathname + '?' + urlParams.toString()
      : location.pathname;
    history.replaceState(null, '', cleanUrl);
  }

  // ---- State ----
  let ws = null;
  let instances = new Map();
  let pastSessions = [];
  let activeInstanceId = null;
  let reconnectDelay = 1000;
  let pendingAttachments = [];
  let selectedAgentType = 'claude';

  // ---- Per-agent model registry ----
  //
  // Drives both the new-session model picker and the mid-session "switch
  // model" pill in the detail header. `presets` are well-known names the
  // operator can select with one tap; `customAllowed` controls whether
  // the picker shows a free-text fallback for anything not in the list.
  // `slashSwitch` is true for agents whose CLI honours an in-session
  // model switch via a slash-command (Claude Code only, today); for the
  // others, mid-session switching means respawning the agent process,
  // which we surface as a warning rather than silently doing it.
  var AGENT_MODELS = {
    claude: {
      slashSwitch: true,           // /model <name> works in claude
      slashCommand: '/model',
      customAllowed: true,
      presets: [
        { id: '',                 label: 'Default (per CLAUDE.md / claude defaults)' },
        { id: 'opus',             label: 'Opus 4.7 — best quality' },
        { id: 'sonnet',           label: 'Sonnet 4.6 — balanced' },
        { id: 'haiku',            label: 'Haiku 4.5 — fastest' },
      ],
    },
    codex: {
      slashSwitch: false,
      customAllowed: true,
      presets: [
        { id: '',                 label: 'Default (codex chooses)' },
        { id: 'gpt-5',            label: 'GPT-5' },
        { id: 'gpt-4o',           label: 'GPT-4o' },
        { id: 'o3',               label: 'o3' },
      ],
    },
    gemini: {
      slashSwitch: false,
      customAllowed: true,
      presets: [
        { id: '',                 label: 'Default' },
        { id: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro' },
        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
        { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      ],
    },
    opencode: {
      slashSwitch: false,
      customAllowed: true,
      presets: [
        { id: '',                                  label: 'Default (provider config)' },
        { id: 'anthropic/claude-sonnet-4-6',       label: 'Anthropic · Claude Sonnet 4.6' },
        { id: 'openai/gpt-4o',                     label: 'OpenAI · GPT-4o' },
        { id: 'openai/gpt-5',                      label: 'OpenAI · GPT-5' },
        { id: 'ollama/llama3.1',                   label: 'Ollama · Llama 3.1 (local)' },
      ],
    },
    pi: {
      slashSwitch: false,
      customAllowed: true,
      presets: [
        { id: '',                                  label: 'Default (pi config)' },
        { id: 'anthropic/claude-sonnet-4-6',       label: 'Anthropic · Claude Sonnet 4.6' },
        { id: 'openai/gpt-4o',                     label: 'OpenAI · GPT-4o' },
        { id: 'openai/gpt-5',                      label: 'OpenAI · GPT-5' },
      ],
    },
    goose: {
      slashSwitch: false,
      customAllowed: true,
      presets: [
        { id: '',                                  label: 'Default (goose config)' },
        { id: 'anthropic/claude-sonnet-4-5',       label: 'Anthropic · Claude Sonnet 4.5' },
        { id: 'openai/gpt-4o-mini',                label: 'OpenAI · GPT-4o-mini' },
      ],
    },
  };

  // Per-instance client-side model state. Keyed by instanceId so it
  // survives instance switching within the same dashboard load. We
  // intentionally do NOT persist across reloads: the server is the
  // source of truth for what was passed at startup, and any /model
  // slash-command is just a regular prompt — there is no separate
  // server endpoint to query "current model" because Claude's CLI is
  // free to switch silently. Treat this as an advisory hint.
  var instanceModelHint = {};

  // Friendly label for a known model id, falling back to the id itself
  // when the operator picked something custom. Pure helper.
  function modelLabelFor(agentType, modelId) {
    if (!modelId) return 'default';
    var spec = AGENT_MODELS[agentType];
    if (spec) {
      for (var i = 0; i < spec.presets.length; i++) {
        if (spec.presets[i].id === modelId) {
          // Trim "(best quality)" tails so the header pill stays short.
          return spec.presets[i].label.split(' — ')[0];
        }
      }
    }
    return modelId;
  }
  let installedSkills = [];
  let skillSearchResults = [];
  let skillSearchTimeout = null;
  let currentSkillDetail = null;

  // ---- Prompt Templates ----
  var DEFAULT_TEMPLATES = [
    { id: 'continue', label: 'Continue', text: 'continue', agents: ['claude', 'codex', 'gemini', 'opencode', 'pi'] },
    { id: 'run-tests', label: 'Run tests', text: 'Run the test suite and fix any failures.', agents: ['claude', 'codex', 'gemini', 'opencode', 'pi'] },
    { id: 'fix-lint', label: 'Fix lint', text: 'Fix all lint errors and warnings.', agents: ['claude', 'codex', 'gemini', 'opencode', 'pi'] },
    { id: 'explain', label: 'Explain', text: 'Explain what you just did and why.', agents: ['claude', 'gemini', 'opencode', 'pi'] },
    { id: 'commit', label: 'Commit', text: 'Create a git commit for the current changes with a descriptive message.', agents: ['claude', 'codex', 'opencode'] },
    { id: 'review', label: 'Review', text: 'Review the changes you made. Check for bugs, security issues, and edge cases.', agents: ['claude', 'gemini', 'opencode', 'pi'] },
  ];
  var VALID_AGENT_TYPES = ['claude', 'codex', 'gemini', 'opencode', 'pi', 'goose', 'mind'];
  var AGENT_LABELS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', pi: 'Pi', goose: 'Goose', mind: 'Mind' };
  function agentLabel(type) { return AGENT_LABELS[type] || 'Claude'; }
  var MAX_TEMPLATE_LENGTH = 500;
  var MAX_CUSTOM_TEMPLATES = 20;
  var customTemplates = loadCustomTemplates();

  // ---- Session Pinning ----
  var pinnedIds = loadPinnedIds();
  function loadPinnedIds() {
    try {
      var raw = localStorage.getItem('polpo_pinned');
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (id) { return typeof id === 'string'; }).slice(0, 10);
    } catch (e) { return []; }
  }
  function savePinnedIds() {
    try { localStorage.setItem('polpo_pinned', JSON.stringify(pinnedIds.slice(0, 10))); } catch (e) {}
  }
  function togglePin(instanceId) {
    var idx = pinnedIds.indexOf(instanceId);
    if (idx !== -1) { pinnedIds.splice(idx, 1); }
    else if (pinnedIds.length < 10) { pinnedIds.push(instanceId); }
    savePinnedIds();
    renderList();
  }

  function loadCustomTemplates() {
    try {
      var raw = localStorage.getItem('polpo_templates');
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (t) {
        return t && typeof t.label === 'string' && t.label.length > 0 && t.label.length <= 40
          && typeof t.text === 'string' && t.text.length > 0 && t.text.length <= MAX_TEMPLATE_LENGTH
          && (!t.agents || Array.isArray(t.agents));
      }).slice(0, MAX_CUSTOM_TEMPLATES);
    } catch (e) { return []; }
  }

  function saveCustomTemplates(templates) {
    try { localStorage.setItem('polpo_templates', JSON.stringify(templates.slice(0, MAX_CUSTOM_TEMPLATES))); } catch (e) {}
  }
  let notificationsEnabled = localStorage.getItem('polpo_notifications') === 'true';
  let pendingApprovalCount = 0;

  // ---- DOM refs ----
  const $connectionStatus = document.getElementById('connection-status');
  const $instanceCount = document.getElementById('instance-count');
  const $emptyState = document.getElementById('empty-state');
  const $instanceList = document.getElementById('instance-list');
  const $viewList = document.getElementById('view-list');
  const $viewDetail = document.getElementById('view-detail');
  const $detailName = document.getElementById('detail-name');
  const $detailStatus = document.getElementById('detail-status');
  const $detailProject = document.getElementById('detail-project');
  const $detailType = document.getElementById('detail-type');
  const $approvalBanner = document.getElementById('approval-banner');
  const $approvalDescription = document.getElementById('approval-description');
  const $approvalCommand = document.getElementById('approval-command');
  const $conversation = document.getElementById('conversation');
  const $promptInput = document.getElementById('prompt-input');
  const $btnSend = document.getElementById('btn-send');
  const $btnBack = document.getElementById('btn-back');
  const $btnAbort = document.getElementById('btn-abort');
  const $btnApprove = document.getElementById('btn-approve');
  const $btnApproveAll = document.getElementById('btn-approve-all');
  const $btnReject = document.getElementById('btn-reject');
  const $autoApprovePill = document.getElementById('auto-approve-pill');
  const $btnStopAutoApprove = document.getElementById('btn-stop-auto-approve');
  const $sessionsSection = document.getElementById('sessions-section');
  const $sessionsList = document.getElementById('sessions-list');
  const $btnRefreshSessions = document.getElementById('btn-refresh-sessions');
  const $takeoverBanner = document.getElementById('takeover-banner');
  const $takeoverHint = document.getElementById('takeover-hint');
  const $takeoverActions = document.getElementById('takeover-actions');
  const $takeoverBusyActions = document.getElementById('takeover-busy-actions');
  const $btnTakeover = document.getElementById('btn-takeover');
  const $btnTakeoverAbort = document.getElementById('btn-takeover-abort');
  const $btnTakeoverWait = document.getElementById('btn-takeover-wait');
  const $inputArea = document.getElementById('input-area');
  const $btnAttach = document.getElementById('btn-attach');
  const $fileInput = document.getElementById('file-input');
  const $attachmentPreview = document.getElementById('attachment-preview');
  const $planBanner = document.getElementById('plan-banner');
  const $planContent = document.getElementById('plan-content');
  const $planText = document.getElementById('plan-text');
  const $btnPlanToggle = document.getElementById('btn-plan-toggle');
  const $btnPlanApprove = document.getElementById('btn-plan-approve');
  const $btnPlanReject = document.getElementById('btn-plan-reject');
  const $questionBanner = document.getElementById('question-banner');
  const $questionList = document.getElementById('question-list');
  const $btnQuestionSubmit = document.getElementById('btn-question-submit');
  const $btnQuestionReject = document.getElementById('btn-question-reject');
  const $btnNewSession = document.getElementById('btn-new-session');
  const $newSessionModal = document.getElementById('new-session-modal');
  const $btnCloseModal = document.getElementById('btn-close-modal');
  const $newAgentType = document.getElementById('new-agent-type');
  const $newCwd = document.getElementById('new-cwd');
  const $cwdSuggestions = document.getElementById('cwd-suggestions');
  const $newName = document.getElementById('new-name');
  const $newModel = document.getElementById('new-model');          // custom-input fallback
  const $newModelSelect = document.getElementById('new-model-select'); // primary dropdown
  const $btnCreateSession = document.getElementById('btn-create-session');
  const $newSessionError = document.getElementById('new-session-error');
  const $btnChanges = document.getElementById('btn-changes');
  const $changesModal = document.getElementById('changes-modal');
  const $btnCloseChanges = document.getElementById('btn-close-changes');
  const $changesFileList = document.getElementById('changes-file-list');
  const $btnSkills = document.getElementById('btn-skills');
  const $skillsManagerModal = document.getElementById('skills-manager-modal');
  const $btnCloseSkillsManager = document.getElementById('btn-close-skills-manager');
  const $skillsSearchInput = document.getElementById('skills-search-input');
  const $skillsSearchResults = document.getElementById('skills-search-results');
  const $installedSkillsList = document.getElementById('installed-skills-list');
  const $skillDetailModal = document.getElementById('skill-detail-modal');
  const $skillDetailName = document.getElementById('skill-detail-name');
  const $skillDetailContent = document.getElementById('skill-detail-content');
  const $btnCloseSkillDetail = document.getElementById('btn-close-skill-detail');
  const $btnSkillAction = document.getElementById('btn-skill-action');
  const $btnWakeLock = document.getElementById('btn-wakelock');
  const $btnNotifications = document.getElementById('btn-notifications');
  const $notificationBadge = document.getElementById('notification-badge');
  const $costSection = document.getElementById('cost-section');
  const $costToday = document.getElementById('cost-today');
  const $costWeek = document.getElementById('cost-week');
  const $costMonth = document.getElementById('cost-month');
  const $costTotal = document.getElementById('cost-total');
  const $costChart = document.getElementById('cost-chart');
  const $btnRefreshCosts = document.getElementById('btn-refresh-costs');
  const $searchInput = document.getElementById('search-input');
  const $searchResults = document.getElementById('search-results');

  // ---- Desktop layout ----
  var desktopBreakpoint = 1024;

  function isDesktop() {
    return window.innerWidth >= desktopBreakpoint;
  }

  function setupDesktopLayout() {
    if (!isDesktop()) {
      // Tear down desktop layout if it exists
      var wrapper = document.querySelector('.desktop-split');
      if (wrapper) {
        wrapper.parentNode.insertBefore($viewList, wrapper);
        wrapper.parentNode.insertBefore($viewDetail, wrapper.nextSibling);
        wrapper.remove();
      }
      return;
    }

    // Already set up
    if (document.querySelector('.desktop-split')) return;

    // Wrap both views in a flex container
    var wrapper = document.createElement('div');
    wrapper.className = 'desktop-split';
    $viewList.parentNode.insertBefore(wrapper, $viewList);
    wrapper.appendChild($viewList);
    wrapper.appendChild($viewDetail);

    // Show both panels
    $viewList.classList.remove('hidden');
    $viewDetail.classList.remove('hidden');

    // Add empty state placeholder if no instance selected
    if (!activeInstanceId) {
      showDesktopDetailEmpty();
    }
  }

  function showDesktopDetailEmpty() {
    if (!isDesktop()) return;
    $conversation.innerHTML =
      '<div class="desktop-detail-empty">' +
      '<img class="empty-icon" src="logo-96.png" alt="" width="48" height="48">' +
      '<div>Select a session to view</div>' +
      '</div>';
  }

  // Initialize on load and handle resize
  setupDesktopLayout();
  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(setupDesktopLayout, 150);
  });

  // ---- System Stats (desktop) ----
  var $statsBar = document.getElementById('stats-bar');
  var $statCpuBar = document.getElementById('stat-cpu-bar');
  var $statCpuVal = document.getElementById('stat-cpu-val');
  var $statMemBar = document.getElementById('stat-mem-bar');
  var $statMemVal = document.getElementById('stat-mem-val');
  var $statUptime = document.getElementById('stat-uptime');
  var $statProcessMem = document.getElementById('stat-process-mem');
  var statsInterval = null;
  var lastStatsData = null;

  // Stats modal refs
  var $statsModal = document.getElementById('stats-modal');
  var $btnCloseStats = document.getElementById('btn-close-stats');
  var $gaugeCpuFill = document.getElementById('gauge-cpu-fill');
  var $gaugeCpuVal = document.getElementById('gauge-cpu-val');
  var $gaugeCpuDetail = document.getElementById('gauge-cpu-detail');
  var $gaugeMemFill = document.getElementById('gauge-mem-fill');
  var $gaugeMemVal = document.getElementById('gauge-mem-val');
  var $gaugeMemDetail = document.getElementById('gauge-mem-detail');
  var $statsHostname = document.getElementById('stats-hostname');
  var $statsPlatform = document.getElementById('stats-platform');
  var $statsSysUptime = document.getElementById('stats-sys-uptime');
  var $statsProcUptime = document.getElementById('stats-proc-uptime');
  var $statsProcMem = document.getElementById('stats-proc-mem');
  var $statsSessionsList = document.getElementById('stats-sessions-list');

  function formatUptime(seconds) {
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    return h + 'h ' + m + 'm';
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  function formatCost(cost) {
    if (cost === 0) return '$0';
    if (cost < 0.01) return '<$0.01';
    return '$' + cost.toFixed(2);
  }

  function setBarLevel(barEl, pct) {
    barEl.style.width = pct + '%';
    barEl.classList.remove('warning', 'critical');
    if (pct >= 90) barEl.classList.add('critical');
    else if (pct >= 70) barEl.classList.add('warning');
  }

  function setGaugeLevel(fillEl, pct) {
    fillEl.setAttribute('stroke-dasharray', pct + ', 100');
    fillEl.classList.remove('warning', 'critical');
    if (pct >= 90) fillEl.classList.add('critical');
    else if (pct >= 70) fillEl.classList.add('warning');
  }

  function pollStats() {
    fetch('/api/stats').then(function (r) { return r.json(); }).then(function (s) {
      lastStatsData = s;

      // Update stats bar
      setBarLevel($statCpuBar, s.cpu.usage);
      $statCpuVal.textContent = s.cpu.usage + '%';
      setBarLevel($statMemBar, s.memory.usage);
      $statMemVal.textContent = s.memory.usage + '%';
      $statUptime.textContent = formatUptime(s.system.uptime);
      $statProcessMem.textContent = formatBytes(s.process.rss);

      // Update modal if open
      if (!$statsModal.classList.contains('hidden')) {
        renderStatsModal(s);
      }
    }).catch(function () {});
  }

  function renderStatsModal(s) {
    // Gauges
    setGaugeLevel($gaugeCpuFill, s.cpu.usage);
    $gaugeCpuVal.textContent = s.cpu.usage + '%';
    $gaugeCpuDetail.textContent = s.cpu.cores + ' cores';

    setGaugeLevel($gaugeMemFill, s.memory.usage);
    $gaugeMemVal.textContent = s.memory.usage + '%';
    $gaugeMemDetail.textContent = formatBytes(s.memory.used) + ' / ' + formatBytes(s.memory.total);

    // Info
    $statsHostname.textContent = s.system.hostname;
    $statsPlatform.textContent = s.system.platform;
    $statsSysUptime.textContent = formatUptime(s.system.uptime);
    $statsProcUptime.textContent = formatUptime(s.process.uptime);
    $statsProcMem.textContent = formatBytes(s.process.rss);

    // Sessions
    if (!s.sessions || s.sessions.length === 0) {
      $statsSessionsList.innerHTML = '<div class="stats-sessions-empty">No active sessions</div>';
      return;
    }

    $statsSessionsList.innerHTML = s.sessions.map(function (sess) {
      var agentLabel = sess.agentType === 'codex' ? 'Codex' :
        sess.agentType === 'gemini' ? 'Gemini' :
        sess.agentType === 'opencode' ? 'OpenCode' :
        sess.agentType === 'pi' ? 'Pi' : 'Claude';
      var safeAgent = escapeHtml(sess.agentType || 'claude');
      return (
        '<div class="stats-session-row">' +
          '<span class="stats-session-agent ' + safeAgent + '">' + escapeHtml(agentLabel) + '</span>' +
          '<span class="stats-session-name" title="' + escapeHtml(sess.name) + '">' + escapeHtml(sess.name) + '</span>' +
          '<span class="stats-session-meta">' +
            '<span>' + formatUptime(sess.uptime) + '</span>' +
            '<span class="stats-session-cost">' + formatCost(sess.cost) + '</span>' +
            '<span>' + sess.messages + ' msgs</span>' +
          '</span>' +
          '<span class="stats-session-status ' + escapeHtml(sess.status) + '">' + escapeHtml(sess.status) + '</span>' +
        '</div>'
      );
    }).join('');
  }

  function openStatsModal() {
    $statsModal.classList.remove('hidden');
    requestAnimationFrame(function () { $statsModal.classList.add('visible'); });
    if (lastStatsData) renderStatsModal(lastStatsData);
    pollStats(); // Refresh immediately
  }

  function closeStatsModal() {
    $statsModal.classList.remove('visible');
    setTimeout(function () { $statsModal.classList.add('hidden'); }, 300);
  }

  // Stats bar click opens modal
  $statsBar.addEventListener('click', openStatsModal);
  $btnCloseStats.addEventListener('click', closeStatsModal);
  $statsModal.addEventListener('click', function (e) {
    if (e.target === $statsModal) closeStatsModal();
  });

  function startStatsPolling() {
    if (statsInterval) return;
    $statsBar.classList.remove('hidden');
    pollStats();
    statsInterval = setInterval(pollStats, 5000);
  }

  function stopStatsPolling() {
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }
    $statsBar.classList.add('hidden');
  }

  // Start/stop on layout change
  if (isDesktop()) startStatsPolling();
  window.addEventListener('resize', function () {
    if (isDesktop()) startStatsPolling();
    else stopStatsPolling();
  });

  // ---- Auth-aware fetch wrapper ----
  function authFetch(url, options) {
    return fetch(url, options).then(function (res) {
      if (res.status === 401) {
        location.href = '/auth.html';
        return Promise.reject(new Error('Unauthorized'));
      }
      return res;
    });
  }

  // ---- WebSocket ----
  var $reconnectBanner = document.getElementById('reconnect-banner');
  var wasConnected = false;

  function setConnectionState(state) {
    $connectionStatus.className = 'status-dot ' + state;
    $connectionStatus.title = state.charAt(0).toUpperCase() + state.slice(1);
    if (state === 'reconnecting') {
      $reconnectBanner.classList.add('visible');
    } else {
      $reconnectBanner.classList.remove('visible');
    }
  }

  var heartbeatCheckTimer = null;
  var HEARTBEAT_STALE_MS = 20000;
  var pingTimer = null;
  var pongReceived = true;
  var isReconnecting = false;

  function startHeartbeatCheck() {
    clearInterval(heartbeatCheckTimer);
    clearInterval(pingTimer);
    var lastMessageTime = Date.now();

    // Check for stale connection every 5s
    heartbeatCheckTimer = setInterval(function () {
      if (Date.now() - lastMessageTime > HEARTBEAT_STALE_MS && ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }, 5000);

    // Send application-level pings every 10s to detect dead connections
    // (browser WebSocket API doesn't expose protocol-level ping/pong)
    pongReceived = true;
    pingTimer = setInterval(function () {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!pongReceived) {
        // No pong since last ping — connection is dead
        ws.close();
        return;
      }
      pongReceived = false;
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
    }, 10000);

    return function () {
      lastMessageTime = Date.now();
      pongReceived = true;
    };
  }

  // Pending reconnect timer — cancelled on forceReconnect/connect to
  // prevent double-connections (which duplicate every broadcast message).
  var reconnectTimer = null;

  function forceReconnect() {
    if (isReconnecting) return;
    reconnectDelay = 1000;
    // Clear any pending reconnect to avoid two concurrent connect() calls
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try { ws.close(); } catch (e) {}
    }
    connect();
  }

  function connect() {
    if (isReconnecting) return;
    // Clear any pending scheduled reconnect — we're connecting now
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Positively detach the previous socket BEFORE opening a new one.
    // ws.close() doesn't transition to CLOSED synchronously — it goes
    // through CLOSING first and during that window the old socket can
    // still receive and dispatch broadcasts. If we leave its handlers
    // attached, every server-side broadcast that lands during the
    // closing window gets handleMessage()'d twice — once via the new
    // socket, once via the old one — and the user sees duplicate
    // bubbles for a single send. Nulling out the handlers first means
    // the old socket can't dispatch anything regardless of how long
    // CLOSING takes.
    if (ws) {
      try {
        ws.onmessage = null;
        ws.onclose = null;
        ws.onopen = null;
        ws.onerror = null;
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      } catch (e) {}
    }
    isReconnecting = true;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}?role=dashboard`;
    if (wasConnected) setConnectionState('reconnecting');
    ws = new WebSocket(url);

    var markAlive = null;

    ws.onopen = function () {
      setConnectionState('connected');
      wasConnected = true;
      reconnectDelay = 1000;
      isReconnecting = false;
      markAlive = startHeartbeatCheck();
    };

    ws.onclose = function (evt) {
      clearInterval(heartbeatCheckTimer);
      clearInterval(pingTimer);
      isReconnecting = false;
      if (evt.code === 4001) {
        location.href = '/auth.html';
        return;
      }
      setConnectionState(wasConnected ? 'reconnecting' : 'disconnected');
      // Store the pending reconnect handle so forceReconnect/connect
      // can cancel it and avoid concurrent connection attempts.
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 8000);
    };

    ws.onmessage = function (evt) {
      if (markAlive) markAlive();
      try {
        var msg = JSON.parse(evt.data);
        if (msg.type === 'pong') return;
        handleMessage(msg);
      } catch (e) {
        // ignore
      }
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ---- Message Handler ----
  function handleMessage(msg) {
    switch (msg.type) {
      case 'snapshot':
        instances.clear();
        msg.instances.forEach(function (inst) {
          inst.conversation = inst.conversation || [];
          inst._firstPrompt = inst.firstPrompt || getFirstPrompt(inst.conversation);
          instances.set(inst.id, inst);
        });
        renderList();
        // Eagerly load firstPrompt for instances missing it
        instances.forEach(function (inst) {
          if (!inst._firstPrompt && inst.sessionId) reloadHistory(inst);
        });
        // After reconnect: reload history for the active detail view
        if (activeInstanceId) {
          var active = instances.get(activeInstanceId);
          if (active) {
            reloadHistory(active);
            renderDetail();
          } else {
            // Instance gone — return to list
            closeDetail();
          }
        }
        break;

      case 'instance:registered':
        msg.instance.conversation = [];
        msg.instance._firstPrompt = msg.instance.firstPrompt || null;
        instances.set(msg.instance.id, msg.instance);
        renderList();
        // Eagerly load firstPrompt if missing
        if (!msg.instance._firstPrompt && msg.instance.sessionId) {
          reloadHistory(msg.instance);
        }
        break;

      case 'instance:disconnected':
        if (instances.has(msg.instanceId)) {
          instances.get(msg.instanceId).status = 'disconnected';
          instances.get(msg.instanceId)._disconnectedAt = Date.now();
        }
        renderList();
        if (activeInstanceId === msg.instanceId) renderDetail();
        break;

      case 'instance:status':
        if (instances.has(msg.id)) {
          var prevStatus = instances.get(msg.id).status;
          instances.get(msg.id).status = msg.status;
          if (msg.status === 'idle' && prevStatus === 'busy') {
            var doneInstName = instances.get(msg.id).name || instances.get(msg.id)._firstPrompt || 'Agent';
            sendNotification('Task Complete', doneInstName + ' finished.', 'done-' + msg.id);
          }
        }
        renderList();
        if (activeInstanceId === msg.id) renderDetail();
        break;

      case 'instance:message':
        if (instances.has(msg.id)) {
          var inst = instances.get(msg.id);
          if (!inst.conversation) inst.conversation = [];

          // ---- Layer 1: clientMsgId reconciliation. ----
          //
          // If the incoming message carries the same UUID the user's
          // own browser stamped on a send_prompt moments ago, this is
          // the server's echo confirming the optimistic local bubble.
          // Replace the pending entry with the server's stamped one
          // (which now has seq + canonical timestamp) and switch the
          // DOM bubble out of its pending state. NO duplicate render.
          //
          // This is the load-bearing change: the user sees their own
          // text immediately on send (via the optimistic insert in
          // sendPrompt()), and the round-trip echo silently confirms.
          if (msg.message && typeof msg.message.clientMsgId === 'string') {
            var reconciled = false;
            for (var pi = inst.conversation.length - 1; pi >= 0; pi--) {
              var existing = inst.conversation[pi];
              if (existing && existing._pending && existing.clientMsgId === msg.message.clientMsgId) {
                inst.conversation[pi] = Object.assign({}, msg.message, { _pending: false });
                if (typeof msg.message.seq === 'number') {
                  inst._lastMessageSeq = msg.message.seq;
                }
                clearOptimisticTimeout(msg.message.clientMsgId);
                if (activeInstanceId === msg.id) {
                  markBubbleConfirmed(msg.message.clientMsgId);
                }
                reconciled = true;
                break;
              }
            }
            if (reconciled) break;
            // Else: this clientMsgId belongs to a different tab or the
            // optimistic bubble was already dropped. Fall through to
            // the standard path so we render it like any new message.
          }

          // ---- Layer 2: seq dedup. ----
          //
          // Defence against duplicate-broadcast delivery (e.g. a
          // stale WebSocket that hasn't fully closed yet still
          // dispatching events). Every server-side addMessage stamps
          // a monotonic per-instance seq; a broadcast we've already
          // processed has seq <= the high-water mark we track here.
          if (msg.message && typeof msg.message.seq === 'number') {
            if (inst._lastMessageSeq != null && msg.message.seq <= inst._lastMessageSeq) {
              break;
            }
            inst._lastMessageSeq = msg.message.seq;
          }

          // ---- Layer 3: history-overlap dedup. ----
          //
          // After history is loaded, skip watcher messages whose
          // (role, content, contentType) tuple matches one already in
          // the recent tail — this is the legacy guard against
          // watcher-replaying an event the history endpoint already
          // returned.
          var dominated = false;
          if (inst._historyLoaded && inst._historyLen) {
            var tail = inst.conversation.slice(-20);
            for (var ti = 0; ti < tail.length; ti++) {
              if (tail[ti].role === msg.message.role &&
                  tail[ti].content === msg.message.content &&
                  tail[ti].contentType === msg.message.contentType) {
                dominated = true;
                break;
              }
            }
          }

          if (!dominated) {
            inst.conversation.push(msg.message);
            // Cache first prompt for card title; re-render list when it first appears
            if (!inst._firstPrompt && msg.message.role === 'user' && (!msg.message.contentType || msg.message.contentType === 'text') && msg.message.content) {
              inst._firstPrompt = msg.message.content;
              renderList();
            }
            if (activeInstanceId === msg.id) {
              appendMessage(msg.message);
            }
          }
        }
        break;

      case 'instance:approval':
        if (instances.has(msg.id)) {
          instances.get(msg.id).pendingApproval = msg.approval;
          if (msg.approval) {
            instances.get(msg.id).status = 'waiting';
            var instName = instances.get(msg.id).name || instances.get(msg.id)._firstPrompt || 'Agent';
            var toolName = msg.approval.tool || 'action';
            sendNotification('Approval Required', instName + ' needs approval for ' + toolName, 'approval-' + msg.id);
          } else {
            instances.get(msg.id).status = 'busy';
          }
        }
        updateNotificationBadge();
        renderList();
        if (activeInstanceId === msg.id) renderDetail();
        break;

      case 'instance:autoApprove':
        if (instances.has(msg.id)) {
          instances.get(msg.id).autoApprove = msg.autoApprove;
        }
        if (activeInstanceId === msg.id) renderDetail();
        break;

      case 'instance:session_info':
        if (instances.has(msg.id)) {
          instances.get(msg.id).sessionId = msg.sessionId;
          instances.get(msg.id).transcriptPath = msg.transcriptPath;
        }
        renderList();
        break;

      case 'instance:cost':
        // Refresh cost dashboard on new cost data
        loadCosts();
        break;

      case 'outbox_update':
        // The hub fired when the agent (in this instance) went idle
        // and produced files in its outbox dir during the just-finished
        // turn. Attach the new files to the most recent assistant
        // message so the dashboard renders download chips on that bubble.
        handleOutboxUpdate(msg.instanceId, msg.newFiles || [], msg.files || []);
        break;
    }
  }

  /**
   * Stamp the most-recent assistant message in this instance's
   * conversation with the new files, then re-render the conversation
   * if it's the active session so the chips appear.
   */
  function handleOutboxUpdate(instanceId, newFileNames, allFiles) {
    if (!instances.has(instanceId)) return;
    var inst = instances.get(instanceId);
    if (!inst.conversation) inst.conversation = [];

    // Resolve full file metadata for each new name from the server's snapshot
    var byName = {};
    for (var i = 0; i < allFiles.length; i++) byName[allFiles[i].name] = allFiles[i];
    var newFileMetas = newFileNames
      .map(function (n) { return byName[n]; })
      .filter(Boolean);
    if (newFileMetas.length === 0) return;

    // Find the last assistant message; if none, fall back to creating a
    // synthetic system message that owns the chips.
    var conv = inst.conversation;
    var targetIdx = -1;
    for (var k = conv.length - 1; k >= 0; k--) {
      if (conv[k].role === 'assistant') { targetIdx = k; break; }
    }
    if (targetIdx === -1) {
      var systemMsg = {
        role: 'assistant',
        content: 'Agent produced files in this turn:',
        contentType: 'text',
        outboxFiles: newFileMetas,
        _outboxInstanceId: instanceId,
        timestamp: Date.now(),
      };
      conv.push(systemMsg);
    } else {
      var target = conv[targetIdx];
      target.outboxFiles = (target.outboxFiles || []).concat(newFileMetas);
      target._outboxInstanceId = instanceId;
    }

    if (activeInstanceId === instanceId) renderDetail();
  }

  // ---- Helpers: Instance ----
  function getFirstPrompt(conversation) {
    if (!conversation) return null;
    for (var i = 0; i < conversation.length; i++) {
      var m = conversation[i];
      if (m.role === 'user' && (!m.contentType || m.contentType === 'text') && m.content) {
        return m.content;
      }
    }
    return null;
  }

  function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max) + '...' : str;
  }

  function showLoading(el, text) {
    el.innerHTML = '<div class="loading-message">' + escapeHtml(text) + '</div>';
  }

  // ---- Render: Instance card HTML ----
  function renderInstanceCard(inst) {
    var badgeClass = 'badge badge-' + inst.status;
    var cardClass = 'instance-card ' + inst.status;
    var isPinned = pinnedIds.indexOf(inst.id) !== -1;
    var approvalHtml = '';
    if (inst.pendingApproval) {
      approvalHtml =
        '<div class="card-approval">⚠ ' +
        escapeHtml(inst.pendingApproval.description || 'Action requires approval') +
        '</div>';
    }
    // Use first prompt as title, fall back to instance name, show spinner only if neither
    var title = inst._firstPrompt
      ? truncate(inst._firstPrompt, 60)
      : inst.name
        ? truncate(inst.name, 60)
        : null;
    var safeId = escapeHtml(inst.id);
    var safeAgentType = VALID_AGENT_TYPES.indexOf(inst.agentType) !== -1 ? inst.agentType : 'claude';
    return (
      '<div class="' + cardClass + '" data-id="' + safeId + '">' +
        '<div class="card-top">' +
          (title
            ? '<span class="card-name">' + escapeHtml(title) + '</span>'
            : '<span class="card-name card-name-loading"><span class="inline-spinner"></span></span>') +
          '<button class="btn-pin' + (isPinned ? ' pinned' : '') + '" data-pin-id="' + safeId + '" title="' + (isPinned ? 'Unpin' : 'Pin') + '">' + (isPinned ? '&#9733;' : '&#9734;') + '</button>' +
          '<span class="' + badgeClass + '">' + (inst.status === 'busy' ? '<span class="pulse-dot"></span>' : '') + escapeHtml(inst.status) + '</span>' +
        '</div>' +
        '<div class="card-meta">' +
          '<span>' + escapeHtml(inst.project || '') + '</span>' +
          '<span class="agent-badge agent-' + safeAgentType + '">' + agentLabel(safeAgentType) + '</span>' +
        '</div>' +
        approvalHtml +
      '</div>'
    );
  }

  // ---- Render: Instance List ----
  function renderList() {
    var arr = Array.from(instances.values()).filter(function (i) {
      if (i.status === 'disconnected') return false;
      // Hide the Alien Mind's reasoning process (auto-discovered by scanner).
      // Its first prompt always starts with the reasoner system prompt.
      var fp = i._firstPrompt || i.firstPrompt || '';
      if (fp.indexOf('You are the coordination brain of Polpo') === 0) return false;
      return true;
    });

    // Also show recently disconnected (last 30s), then purge stale ones
    var now = Date.now();
    Array.from(instances.entries()).forEach(function (entry) {
      var id = entry[0], i = entry[1];
      if (i.status !== 'disconnected') return;
      if (now - (i._disconnectedAt || 0) < 30000) {
        arr.push(i);
      } else {
        instances.delete(id);
      }
    });

    // Deduplicate: when multiple instances share the same sessionId,
    // keep only the one with the best status (busy > idle > disconnected)
    var seenSessions = {};
    var statusRank = { waiting: 0, busy: 1, idle: 2, paused: 3, disconnected: 4 };
    arr = arr.filter(function (inst) {
      if (!inst.sessionId) return true;
      var prev = seenSessions[inst.sessionId];
      var rank = statusRank[inst.status] !== undefined ? statusRank[inst.status] : 5;
      if (!prev || rank < prev.rank) {
        seenSessions[inst.sessionId] = { inst: inst, rank: rank };
        return true;
      }
      return false;
    });
    // Second pass: remove losers
    var kept = {};
    Object.keys(seenSessions).forEach(function (sid) { kept[seenSessions[sid].inst.id] = true; });
    arr = arr.filter(function (inst) {
      return !inst.sessionId || kept[inst.id];
    });

    $instanceCount.textContent = arr.length + ' instance' + (arr.length !== 1 ? 's' : '');

    // Re-render past sessions (to remove any that are now active)
    renderSessions();

    if (arr.length === 0) {
      if (pastSessions.length === 0) {
        $emptyState.classList.remove('hidden');
      } else {
        $emptyState.classList.add('hidden');
      }
      $instanceList.innerHTML = '';
      return;
    }

    $emptyState.classList.add('hidden');

    // Sort: pinned first, then by status priority, then by recency
    var statusPriority = { waiting: 0, busy: 1, idle: 2, paused: 3, disconnected: 4 };
    arr.sort(function (a, b) {
      var aPinned = pinnedIds.indexOf(a.id) !== -1 ? 0 : 1;
      var bPinned = pinnedIds.indexOf(b.id) !== -1 ? 0 : 1;
      if (aPinned !== bPinned) return aPinned - bPinned;
      var aPri = statusPriority[a.status] !== undefined ? statusPriority[a.status] : 5;
      var bPri = statusPriority[b.status] !== undefined ? statusPriority[b.status] : 5;
      if (aPri !== bPri) return aPri - bPri;
      return 0;
    });

    // Split into mind group (Alien Mind + its arms) and regular instances.
    //
    // The arm is identified by its source tag — every arm the coordinator
    // spawns through OneShotAgentRunner gets registered with
    // `source: 'mind:<goalId-tail>'`. That's the canonical signal and
    // it survives display-name renames. The legacy name-prefix check
    // ('Arm: ', 'Mind arm: ') is kept as a fallback for any non-runner
    // path that might still set the display name without the source tag.
    var mindGroup = [];
    var regular = [];
    for (var m = 0; m < arr.length; m++) {
      var inst = arr[m];
      var isMindArm =
        inst.agentType === 'mind'
        || (typeof inst.source === 'string' && inst.source.indexOf('mind:') === 0)
        || (inst.name && (inst.name.indexOf('Mind arm: ') === 0 || inst.name.indexOf('Arm: ') === 0));
      if (isMindArm) {
        mindGroup.push(inst);
      } else {
        regular.push(inst);
      }
    }

    // Within the mind group: mind itself first, then arms
    mindGroup.sort(function (a, b) {
      if (a.agentType === 'mind' && b.agentType !== 'mind') return -1;
      if (a.agentType !== 'mind' && b.agentType === 'mind') return 1;
      return 0;
    });

    var $mindSection = document.getElementById('mind-section');
    var $mindList = document.getElementById('mind-list');
    if (mindGroup.length > 0) {
      $mindSection.classList.remove('hidden');
      $mindList.innerHTML = mindGroup.map(renderInstanceCard).join('');
    } else {
      $mindSection.classList.add('hidden');
      $mindList.innerHTML = '';
    }

    $instanceList.innerHTML = regular.map(renderInstanceCard).join('');

    // Attach click handlers to ALL cards (mind section + regular)
    var allCards = document.querySelectorAll('#mind-list .instance-card, #instance-list .instance-card');
    for (var i = 0; i < allCards.length; i++) {
      allCards[i].addEventListener('click', onCardClick);
    }
    // Attach pin handlers
    var pins = document.querySelectorAll('#mind-list .btn-pin, #instance-list .btn-pin');
    for (var i = 0; i < pins.length; i++) {
      pins[i].addEventListener('click', function (e) {
        e.stopPropagation();
        togglePin(e.currentTarget.getAttribute('data-pin-id'));
      });
    }

    // Desktop: maintain selected card highlight after re-render
    if (isDesktop() && activeInstanceId) {
      highlightSelectedCard(activeInstanceId);
    }
  }

  function onCardClick(e) {
    var card = e.currentTarget;
    var id = card.getAttribute('data-id');
    openDetail(id);
  }

  /**
   * Load (or reload) conversation history for an instance.
   * Uses the JSONL history endpoint when a sessionId is available,
   * otherwise falls back to the in-memory conversation endpoint.
   */
  var HISTORY_PAGE_SIZE = 30;

  function reloadHistory(inst, forceScroll) {
    if (inst.sessionId) {
      // Load only the last page initially for faster rendering
      authFetch('/api/sessions/' + inst.sessionId + '/history?tail=' + HISTORY_PAGE_SIZE)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          // Handle paginated response (has .messages) or legacy flat array
          var messages = data.messages || data;
          var total = data.total || messages.length;
          if (messages.length > 0) {
            inst.conversation = preservePending(inst.conversation, messages);
            inst._historyLen = total;
            inst._totalMessages = total;
            inst._loadedFrom = total - messages.length; // index of first loaded message
          } else {
            inst.conversation = preservePending(inst.conversation, []);
            inst._totalMessages = inst.conversation.length;
            inst._loadedFrom = 0;
          }
          inst._historyLoaded = true;
          inst._loadingOlder = false;
          if (!inst._firstPrompt) {
            inst._firstPrompt = getFirstPrompt(inst.conversation);
            renderList();
          }
          if (activeInstanceId === inst.id) {
            renderConversation();
            if (forceScroll) scrollToBottom(true);
          }
        })
        .catch(function () {});
    } else {
      authFetch('/api/instances/' + inst.id + '/conversation?limit=100')
        .then(function (r) { return r.json(); })
        .then(function (msgs) {
          inst.conversation = preservePending(inst.conversation, msgs);
          inst._totalMessages = inst.conversation.length;
          inst._loadedFrom = 0;
          inst._loadingOlder = false;
          // Reset the dedup high-water mark to the highest seq in the
          // reloaded conversation. Any subsequent live broadcast with a
          // smaller-or-equal seq is a duplicate and gets dropped.
          inst._lastMessageSeq = highestSeq(msgs);
          if (!inst._firstPrompt) {
            inst._firstPrompt = getFirstPrompt(inst.conversation);
            renderList();
          }
          if (activeInstanceId === inst.id) {
            renderConversation();
            if (forceScroll) scrollToBottom(true);
          }
        })
        .catch(function () {});
    }
  }

  function highestSeq(messages) {
    if (!Array.isArray(messages)) return null;
    var max = null;
    for (var i = 0; i < messages.length; i++) {
      var s = messages[i] && messages[i].seq;
      if (typeof s === 'number' && (max == null || s > max)) max = s;
    }
    return max;
  }

  /**
   * Carry over any still-pending optimistic messages when a history
   * reload replaces the conversation array. Without this, a reload
   * triggered while the user has an in-flight send (e.g. a WS reconnect
   * mid-prompt) would silently swallow the bubble they were watching.
   *
   * Pending messages keep their clientMsgId so the eventual server
   * echo can still reconcile them — no special case downstream.
   */
  function preservePending(oldConversation, freshList) {
    var fresh = Array.isArray(freshList) ? freshList : [];
    if (!Array.isArray(oldConversation) || oldConversation.length === 0) return fresh;
    var pending = oldConversation.filter(function (m) { return m && m._pending; });
    if (pending.length === 0) return fresh;
    return fresh.concat(pending);
  }

  function loadOlderMessages(inst) {
    if (!inst || !inst.sessionId || inst._loadingOlder) return;
    if (inst._loadedFrom <= 0) return; // already have everything

    inst._loadingOlder = true;
    var end = inst._loadedFrom;
    var start = Math.max(0, end - HISTORY_PAGE_SIZE);

    authFetch('/api/sessions/' + inst.sessionId + '/history?offset=' + start + '&limit=' + (end - start))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var older = data.messages || data;
        if (older.length > 0) {
          inst.conversation = older.concat(inst.conversation);
          inst._loadedFrom = start;

          // Preserve scroll position: measure before, render, restore
          if (activeInstanceId === inst.id) {
            var prevHeight = $conversation.scrollHeight;
            var prevScroll = $conversation.scrollTop;
            renderConversation(true); // skipScroll = true
            var newHeight = $conversation.scrollHeight;
            $conversation.scrollTop = prevScroll + (newHeight - prevHeight);
          }
        }
        inst._loadingOlder = false;
      })
      .catch(function () {
        inst._loadingOlder = false;
      });
  }

  // ---- Render: Detail View ----
  function openDetail(id) {
    // Switching to a new conversation: drop any in-conversation search
    // highlights so we don't leak stale <mark> elements across sessions.
    if (typeof closeConvSearch === 'function') closeConvSearch();

    activeInstanceId = id;

    var inst = instances.get(id);
    if (inst) {
      var hasConversation = inst.conversation && inst.conversation.length > 0;
      if ((inst.sessionId && !inst._historyLoaded) || !hasConversation) {
        showLoading($conversation, 'Loading conversation...');
        reloadHistory(inst, true);
      }
      // Sync the outbox-enabled flag from the server. The pill paints
      // immediately from `instanceOutboxEnabled` (off by default); the
      // refresh corrects it once the server responds.
      refreshOutboxState(id);
    }

    if (isDesktop()) {
      // Desktop: highlight selected card, both panels stay visible
      highlightSelectedCard(id);
    } else {
      $viewList.classList.add('hidden');
      $viewDetail.classList.remove('hidden');
    }
    renderDetail();
    if (!inst || (inst.conversation && inst.conversation.length > 0)) {
      renderConversation();
      scrollToBottom(true);
    }
    $promptInput.focus();
  }

  function closeDetail() {
    if (typeof closeConvSearch === 'function') closeConvSearch();
    activeInstanceId = null;
    if (isDesktop()) {
      highlightSelectedCard(null);
      showDesktopDetailEmpty();
      renderDetail();
    } else {
      $viewDetail.classList.add('hidden');
      $viewList.classList.remove('hidden');
    }
    renderList();
  }

  function highlightSelectedCard(id) {
    var cards = $instanceList.querySelectorAll('.instance-card');
    cards.forEach(function (card) {
      if (card.dataset.id === id) {
        card.classList.add('selected');
      } else {
        card.classList.remove('selected');
      }
    });
  }

  function renderDetail() {
    var inst = instances.get(activeInstanceId);
    if (!inst) return;

    var detailTitle = inst._firstPrompt || inst.name || '';
    if (detailTitle) {
      $detailName.textContent = truncate(detailTitle, 80);
      $detailName.classList.remove('detail-name-loading');
    } else {
      $detailName.textContent = '';
      $detailName.classList.add('detail-name-loading');
    }
    $detailStatus.className = 'badge badge-' + inst.status;
    if (inst.status === 'busy') {
      $detailStatus.innerHTML = '<span class="pulse-dot"></span>' + escapeHtml(inst.status);
    } else {
      $detailStatus.textContent = inst.status;
    }
    $detailProject.textContent = '📁 ' + (inst.project || '');
    var detailAgentType = VALID_AGENT_TYPES.indexOf(inst.agentType) !== -1 ? inst.agentType : 'claude';
    $detailType.innerHTML = '<span class="agent-badge agent-' + detailAgentType + '">' + agentLabel(detailAgentType) + '</span>';
    renderModelPill(inst, detailAgentType);
    renderOutboxPill(inst);

    // Skills button — only for Claude instances
    var isClaude = !inst.agentType || inst.agentType === 'claude';
    if (isClaude) {
      $btnSkills.classList.remove('hidden');
    } else {
      $btnSkills.classList.add('hidden');
    }

    // Template bar
    renderTemplateBar();

    // Takeover vs prompt input
    var canPrompt = inst.canReceivePrompts !== false;
    if (!canPrompt && inst.sessionId) {
      $takeoverBanner.classList.remove('hidden');
      $inputArea.classList.add('hidden');
      // Show different UI based on whether agent is busy
      if (inst.status === 'busy') {
        $takeoverHint.textContent = 'This session is busy in your terminal. Abort the current task first, or wait for it to finish.';
        $takeoverActions.classList.add('hidden');
        $takeoverBusyActions.classList.remove('hidden');
      } else {
        $takeoverHint.textContent = 'This session is running in your terminal. To send prompts from here, take over.';
        $takeoverActions.classList.remove('hidden');
        $takeoverBusyActions.classList.add('hidden');
      }
    } else {
      $takeoverBanner.classList.add('hidden');
      $inputArea.classList.remove('hidden');
    }

    // Auto-approve indicator (pill in title + stop button in actions)
    if (inst.autoApprove) {
      $autoApprovePill.classList.remove('hidden');
      $btnStopAutoApprove.classList.remove('hidden');
    } else {
      $autoApprovePill.classList.add('hidden');
      $btnStopAutoApprove.classList.add('hidden');
    }

    // Approval banners - show the right one based on approval type
    var approval = inst.pendingApproval;
    var aType = approval && approval.approvalType || 'tool';

    // Hide all banners first
    $approvalBanner.classList.add('hidden');
    $planBanner.classList.add('hidden');
    $questionBanner.classList.add('hidden');

    if (approval && (aType !== 'tool' || !inst.autoApprove)) {
      if (aType === 'plan') {
        $planBanner.classList.remove('hidden');
        $planText.innerHTML = renderPlanMarkdown(approval.command || 'No plan content available.');
      } else if (aType === 'question') {
        $questionBanner.classList.remove('hidden');
        renderQuestions(approval.questions || []);
      } else {
        $approvalBanner.classList.remove('hidden');
        $approvalDescription.textContent = approval.description || '';
        $approvalCommand.textContent = approval.command || '';
        if (!approval.command) {
          $approvalCommand.style.display = 'none';
        } else {
          $approvalCommand.style.display = 'block';
        }
      }
    }

    // Reflect instance status in send button enable state
    updateSendButton();
  }

  function renderConversation(skipScroll) {
    var inst = instances.get(activeInstanceId);
    if (!inst || !inst.conversation) {
      $conversation.innerHTML = '';
      return;
    }

    // Pre-process: pair tool_use with their tool_result by toolUseId
    var merged = mergeToolMessages(inst.conversation);
    var html = '';

    // Show "load more" sentinel if there are older messages
    if (inst._loadedFrom > 0) {
      html += '<div class="load-more-sentinel" id="load-more-sentinel">' +
        '<span class="loading-message">Loading earlier messages...</span></div>';
    }

    html += merged.map(function (m) { return formatMessage(m); }).join('');
    $conversation.innerHTML = html;
    if (!skipScroll) {
      scrollToBottom();
      // Re-scroll when images finish loading (their height is 0 at insert time)
      var imgs = $conversation.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) {
        imgs[i].addEventListener('load', function () { scrollToBottom(true); });
      }
    }
    // If a global search result triggered this render, jump straight to
    // the match the user clicked. No-op when there's no pending query.
    if (typeof applyPendingConvSearch === 'function') applyPendingConvSearch();
  }

  /**
   * Merge tool_use and tool_result messages into unified blocks.
   * Returns a new array where paired tool messages become { contentType: 'tool_block' }.
   */
  function mergeToolMessages(messages) {
    // Build a map of toolUseId -> tool_result
    var resultMap = {};
    messages.forEach(function (m) {
      if (m.contentType === 'tool_result' && m.toolUseId) {
        resultMap[m.toolUseId] = m;
      }
    });

    var merged = [];
    var consumedResultIds = {};

    messages.forEach(function (m) {
      if (m.contentType === 'tool_use') {
        try {
          var tool = JSON.parse(m.content);
          var result = tool.id ? resultMap[tool.id] : null;
          if (result) consumedResultIds[result.toolUseId] = true;
          merged.push({
            contentType: 'tool_block',
            tool: tool,
            result: result,
            timestamp: m.timestamp,
            source: m.source,
          });
        } catch (e) {
          merged.push(m);
        }
        return;
      }
      // Skip tool_results that were already merged
      if (m.contentType === 'tool_result' && m.toolUseId && consumedResultIds[m.toolUseId]) {
        return;
      }
      merged.push(m);
    });

    return merged;
  }

  function appendMessage(msg) {
    // Capture scroll intent BEFORE inserting content — once inserted,
    // the new content height inflates scrollHeight and isNearBottom()
    // may return false even though the user was following the stream.
    var shouldScroll = isNearBottom();

    // For tool_result: try to merge into the preceding tool_use block
    if (msg.contentType === 'tool_result' && msg.toolUseId) {
      var safeId = CSS.escape(msg.toolUseId);
      var toolBlock = $conversation.querySelector('[data-tool-id="' + safeId + '"]');
      if (toolBlock) {
        var output = msg.content || '';
        output = output.replace(/<\/?tool_use_error>/g, '');
        var isError = msg.isError;
        if (output.length > 800) {
          output = output.slice(0, 800) + '\n... (' + msg.content.length + ' chars)';
        }
        var resultDiv = document.createElement('div');
        resultDiv.className = 'tool-block-output' + (isError ? ' tool-error' : '');
        resultDiv.innerHTML =
          '<div class="tool-block-label">OUT</div>' +
          '<pre>' + escapeHtml(output) + '</pre>';
        toolBlock.appendChild(resultDiv);
        if (shouldScroll) scrollToBottom(true);
        return;
      }
    }
    $conversation.insertAdjacentHTML('beforeend', formatMessage(msg));
    if (shouldScroll) {
      scrollToBottom(true);
      // Images load asynchronously — their height is 0 at insert time, then
      // expands when data arrives, pushing content below the viewport.
      // Re-scroll after each image loads to keep the view pinned to bottom.
      var imgs = $conversation.lastElementChild
        ? $conversation.lastElementChild.querySelectorAll('img')
        : [];
      for (var i = 0; i < imgs.length; i++) {
        imgs[i].addEventListener('load', function () { scrollToBottom(true); });
      }
    }
  }

  function formatMessage(m) {
    var contentType = m.contentType || 'text';
    var time = m.timestamp ? formatTime(m.timestamp) : '';
    var timeHtml = time ? '<div class="msg-time">' + time + '</div>' : '';

    // Unified tool block (tool_use + tool_result merged)
    if (contentType === 'tool_block') {
      return renderToolBlock(m.tool, m.result, timeHtml);
    }

    // Tool use: render as unified block (fallback for streaming/unmerged)
    if (contentType === 'tool_use') {
      try {
        var tool = JSON.parse(m.content);
        return renderToolBlock(tool, null, timeHtml);
      } catch (e) {}
    }

    // Tool result: render standalone (fallback for orphan results)
    if (contentType === 'tool_result') {
      var cls = 'msg msg-tool-result' + (m.isError ? ' tool-error' : '');
      var content = m.content || '';
      content = content.replace(/<\/?tool_use_error>/g, '');
      if (content.length > 500) {
        content = content.slice(0, 500) + '\n...';
      }
      return (
        '<div class="' + cls + '">' +
          '<div class="tool-block-label">OUT</div>' +
          '<pre>' + escapeHtml(content) + '</pre>' +
          timeHtml +
        '</div>'
      );
    }

    // Turn complete: show cost/turns as system message
    if (contentType === 'turn_complete') {
      try {
        var info = JSON.parse(m.content);
        var costStr = info.cost_usd ? '$' + info.cost_usd.toFixed(4) : '';
        return (
          '<div class="msg msg-system msg-turn-complete">' +
            (costStr ? costStr + ' · ' : '') +
            (info.num_turns || '') + ' turns' +
            timeHtml +
          '</div>'
        );
      } catch (e) {}
    }

    // Inline image (base64 from JSONL or uploaded)
    if (contentType === 'image') {
      var imgCls = 'msg msg-' + (m.role || 'user');
      return (
        '<div class="' + imgCls + '">' +
          '<img class="msg-inline-image" src="' + escapeHtml(m.content) + '" alt="image">' +
          timeHtml +
        '</div>'
      );
    }

    // JSON system init: skip rendering
    if (contentType === 'json' && m.role === 'system') {
      return '';
    }

    // Default: text message
    var cls = 'msg msg-' + (m.role || 'system');
    if (m.source === 'mobile') cls += ' from-mobile';
    // Optimistic-render flags. The DOM exposes data-client-msg-id so
    // the confirmation handler can find the bubble for in-place state
    // updates without re-rendering the whole conversation.
    if (m._pending) cls += ' msg-pending';
    if (m._failed) cls += ' msg-failed';
    var cmsgAttr = m.clientMsgId
      ? ' data-client-msg-id="' + escapeHtml(m.clientMsgId) + '"'
      : '';
    var rendered = m.role === 'assistant'
      ? renderMarkdown(m.content || '')
      : escapeHtml(m.content || '');

    // Attachment indicators for user messages
    var attachHtml = '';
    if (m.attachments && m.attachments.length > 0) {
      attachHtml = '<div class="msg-attachments">' +
        m.attachments.map(function (att) {
          if (att.mediaType && att.mediaType.startsWith('image/')) {
            var thumbUrl = '/api/uploads/' + encodeURIComponent(att.path.split('/').pop());
            return '<img class="msg-attachment-thumb" src="' + escapeHtml(thumbUrl) + '" alt="' + escapeHtml(att.filename) + '">';
          }
          return '<span class="msg-attachment-file">&#128196; ' + escapeHtml(att.filename) + '</span>';
        }).join('') +
      '</div>';
    }

    // Outbox chips: files the agent produced during this assistant turn
    // (assistant messages only; the websocket layer attaches these when
    // the agent goes idle and the outbox dir diff is non-empty).
    var outboxHtml = '';
    if (m.role === 'assistant' && Array.isArray(m.outboxFiles) && m.outboxFiles.length > 0) {
      var instIdForLink = m._outboxInstanceId || activeInstanceId || '';
      outboxHtml = '<div class="msg-outbox">' +
        m.outboxFiles.map(function (f) {
          var sizeStr = f.size != null ? humanFileSize(f.size) : '';
          return '<a class="msg-outbox-chip" ' +
            'data-instance-id="' + escapeHtml(instIdForLink) + '" ' +
            'data-outbox-name="' + escapeHtml(f.name) + '" ' +
            'title="Download ' + escapeHtml(f.name) + '">' +
            '<span class="msg-outbox-chip-icon">&#11015;</span>' +
            '<span>' + escapeHtml(f.name) + '</span>' +
            (sizeStr ? '<span class="msg-outbox-chip-size">' + escapeHtml(sizeStr) + '</span>' : '') +
            '</a>';
        }).join('') +
      '</div>';
    }

    return (
      '<div class="' + cls + '"' + cmsgAttr + '>' +
        attachHtml +
        rendered +
        outboxHtml +
        timeHtml +
      '</div>'
    );
  }

  function humanFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  /**
   * Render a unified tool block (tool_use + optional tool_result).
   * Shows: tool name header, description, IN command, OUT result.
   */
  function renderToolBlock(tool, result, timeHtml) {
    var name = tool.name || 'Tool';
    var description = '';
    var inputSummary = '';
    var isDiff = false;
    var isFileCreate = false;

    if (name === 'Bash' || name === 'bash') {
      description = tool.input && tool.input.description || '';
      inputSummary = tool.input && tool.input.command || '';
    } else if (name === 'Read') {
      inputSummary = tool.input && tool.input.file_path || '';
    } else if (name === 'Edit' && tool.input && tool.input.old_string && tool.input.new_string) {
      inputSummary = '';
      description = tool.input.file_path || 'file';
      isDiff = true;
    } else if (name === 'Write' && tool.input && tool.input.content) {
      inputSummary = '';
      description = tool.input.file_path || 'file';
      isFileCreate = true;
    } else if (name === 'Edit' || name === 'Write') {
      inputSummary = tool.input && tool.input.file_path || '';
      if (tool.input && tool.input.old_string) {
        description = 'Replace in file';
      }
    } else if (name === 'Grep') {
      inputSummary = tool.input && tool.input.pattern || '';
      if (tool.input && tool.input.path) {
        inputSummary += ' in ' + tool.input.path;
      }
    } else if (name === 'Glob') {
      inputSummary = tool.input && tool.input.pattern || '';
    } else if (name === 'WebSearch') {
      inputSummary = tool.input && tool.input.query || '';
    } else if (name === 'WebFetch') {
      inputSummary = tool.input && tool.input.url || '';
    } else if (name === 'Task' || name === 'TodoWrite') {
      description = tool.input && tool.input.description || '';
      inputSummary = '';
    } else if (name === 'ExitPlanMode') {
      description = 'Plan ready for review';
      inputSummary = '';
    } else if (name === 'EnterPlanMode') {
      description = 'Entering plan mode';
      inputSummary = '';
    } else if (name === 'AskUserQuestion') {
      var qs = tool.input && tool.input.questions || [];
      description = qs.length === 1 ? qs[0].question : qs.length + ' questions';
      inputSummary = '';
    } else {
      var rawInput = JSON.stringify(tool.input || {});
      if (rawInput.length > 150) rawInput = rawInput.slice(0, 150) + '...';
      inputSummary = rawInput;
    }

    // Build result HTML
    var resultHtml = '';
    if (result) {
      var output = result.content || '';
      output = output.replace(/<\/?tool_use_error>/g, '');
      var isError = result.isError;
      var isTruncated = output.length > 800;
      if (isTruncated) {
        output = output.slice(0, 800) + '\n... (' + result.content.length + ' chars)';
      }
      resultHtml =
        '<div class="tool-block-output' + (isError ? ' tool-error' : '') + '">' +
          '<div class="tool-block-label">OUT</div>' +
          '<pre>' + escapeHtml(output) + '</pre>' +
        '</div>';
    }

    // Diff view for Edit tool
    var diffHtml = '';
    if (isDiff) {
      diffHtml = renderDiffView(tool.input.old_string, tool.input.new_string, tool.input.file_path);
    } else if (isFileCreate) {
      var content = tool.input.content || '';
      var lines = content.split('\n');
      var maxLines = 20;
      var truncated = lines.length > maxLines;
      var shown = truncated ? lines.slice(0, maxLines) : lines;
      diffHtml =
        '<div class="diff-block">' +
          '<div class="diff-header">' + escapeHtml(tool.input.file_path || 'new file') + '</div>' +
          '<pre class="diff-body">' +
            shown.map(function (line, i) {
              return '<span class="diff-line-add"><span class="diff-gutter">' + (i + 1) + '</span>' + escapeHtml(line) + '</span>';
            }).join('') +
            (truncated ? '<span class="diff-line-ctx"><span class="diff-gutter">...</span> ' + (lines.length - maxLines) + ' more lines</span>' : '') +
          '</pre>' +
        '</div>';
    }

    var toolId = tool.id || '';

    return (
      '<div class="msg msg-tool-block"' + (toolId ? ' data-tool-id="' + escapeHtml(toolId) + '"' : '') + '>' +
        '<div class="tool-block-header">' +
          '<span class="tool-block-name">' + escapeHtml(name) + '</span>' +
          (description ? '<span class="tool-block-desc">' + escapeHtml(description) + '</span>' : '') +
        '</div>' +
        (inputSummary
          ? '<div class="tool-block-input">' +
              '<div class="tool-block-label">IN</div>' +
              '<pre>' + escapeHtml(inputSummary) + '</pre>' +
            '</div>'
          : '') +
        diffHtml +
        resultHtml +
        timeHtml +
      '</div>'
    );
  }

  /**
   * Render a unified diff view from old_string and new_string.
   */
  var diffIdCounter = 0;

  // Syntax highlight rules (applied to already-escaped HTML)
  var SYNTAX_RULES = {
    js: [
      { pattern: /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|this|try|catch|throw|typeof|instanceof|switch|case|break|continue|default|yield)\b/g, cls: 'syn-keyword' },
      { pattern: /\b(true|false|null|undefined|NaN|Infinity)\b/g, cls: 'syn-literal' },
      { pattern: /\b(\d+\.?\d*)\b/g, cls: 'syn-number' },
    ],
    py: [
      { pattern: /\b(def|class|if|elif|else|for|while|return|import|from|as|try|except|raise|with|yield|async|await|pass|break|continue|lambda|in|not|and|or|is)\b/g, cls: 'syn-keyword' },
      { pattern: /\b(True|False|None)\b/g, cls: 'syn-literal' },
      { pattern: /\b(\d+\.?\d*)\b/g, cls: 'syn-number' },
    ],
    go: [
      { pattern: /\b(func|package|import|return|if|else|for|range|switch|case|break|continue|default|var|const|type|struct|interface|map|chan|go|defer|select|fallthrough)\b/g, cls: 'syn-keyword' },
      { pattern: /\b(true|false|nil|iota)\b/g, cls: 'syn-literal' },
      { pattern: /\b(\d+\.?\d*)\b/g, cls: 'syn-number' },
    ],
    sh: [
      { pattern: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|local|export|source|set)\b/g, cls: 'syn-keyword' },
      { pattern: /\b(\d+)\b/g, cls: 'syn-number' },
    ],
  };
  var EXT_TO_LANG = {
    '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
    '.ts': 'js', '.tsx': 'js', '.py': 'py', '.go': 'go',
    '.sh': 'sh', '.bash': 'sh', '.rs': 'go',
  };

  function highlightSyntax(escapedText, filePath) {
    if (!filePath) return escapedText;
    var dotIdx = filePath.lastIndexOf('.');
    if (dotIdx === -1) return escapedText;
    var ext = filePath.slice(dotIdx).toLowerCase();
    var rules = SYNTAX_RULES[EXT_TO_LANG[ext]];
    if (!rules) return escapedText;
    var tokens = [];
    var result = escapedText;
    rules.forEach(function (rule) {
      result = result.replace(rule.pattern, function (match) {
        var idx = tokens.length;
        tokens.push('<span class="' + rule.cls + '">' + match + '</span>');
        return '\x00SYN' + idx + '\x00';
      });
    });
    return result.replace(/\x00SYN(\d+)\x00/g, function (m, idx) { return tokens[parseInt(idx)]; });
  }

  function computeWordDiff(oldText, newText) {
    var oldWords = oldText.split(/(\s+)/);
    var newWords = newText.split(/(\s+)/);
    if (oldWords.length > 100 || newWords.length > 100) {
      return { oldHtml: escapeHtml(oldText), newHtml: escapeHtml(newText) };
    }
    var m = oldWords.length, n = newWords.length;
    var dp = [];
    for (var i = 0; i <= m; i++) {
      dp[i] = [];
      for (var j = 0; j <= n; j++) {
        if (i === 0 || j === 0) dp[i][j] = 0;
        else if (oldWords[i - 1] === newWords[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
        else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    var oldParts = [], newParts = [];
    var oi = m, ni = n;
    while (oi > 0 || ni > 0) {
      if (oi > 0 && ni > 0 && oldWords[oi - 1] === newWords[ni - 1]) {
        oldParts.unshift(escapeHtml(oldWords[oi - 1]));
        newParts.unshift(escapeHtml(newWords[ni - 1]));
        oi--; ni--;
      } else if (ni > 0 && (oi === 0 || dp[oi][ni - 1] >= dp[oi - 1][ni])) {
        newParts.unshift('<mark class="diff-word-add">' + escapeHtml(newWords[ni - 1]) + '</mark>');
        ni--;
      } else {
        oldParts.unshift('<mark class="diff-word-del">' + escapeHtml(oldWords[oi - 1]) + '</mark>');
        oi--;
      }
    }
    return { oldHtml: oldParts.join(''), newHtml: newParts.join('') };
  }

  function renderDiffView(oldStr, newStr, filePath) {
    var oldLines = (oldStr || '').split('\n');
    var newLines = (newStr || '').split('\n');
    var diff = computeLineDiff(oldLines, newLines);
    var addCount = 0, delCount = 0;
    diff.forEach(function (d) {
      if (d.type === 'add') addCount++;
      else if (d.type === 'del') delCount++;
    });

    // Word-level diff: pair adjacent del+add lines
    var enhanced = [];
    for (var i = 0; i < diff.length; i++) {
      if (diff[i].type === 'del' && i + 1 < diff.length && diff[i + 1].type === 'add') {
        var wd = computeWordDiff(diff[i].text, diff[i + 1].text);
        enhanced.push({ type: 'del', text: diff[i].text, html: wd.oldHtml });
        enhanced.push({ type: 'add', text: diff[i + 1].text, html: wd.newHtml });
        i++;
      } else {
        enhanced.push({ type: diff[i].type, text: diff[i].text, html: null });
      }
    }

    var oldLineNo = 1, newLineNo = 1;
    var linesHtml = enhanced.map(function (d) {
      var leftNum = '', rightNum = '';
      if (d.type === 'ctx') { leftNum = oldLineNo++; rightNum = newLineNo++; }
      else if (d.type === 'del') { leftNum = oldLineNo++; }
      else if (d.type === 'add') { rightNum = newLineNo++; }
      var prefix = d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' ';
      var cls = d.type === 'add' ? 'diff-line-add' : d.type === 'del' ? 'diff-line-del' : 'diff-line-ctx';
      var content = d.html || highlightSyntax(escapeHtml(d.text), filePath);
      return '<span class="' + cls + '">' +
        '<span class="diff-gutter-num">' + leftNum + '</span>' +
        '<span class="diff-gutter-num">' + rightNum + '</span>' +
        '<span class="diff-gutter-sign">' + prefix + '</span>' +
        content + '</span>';
    }).join('');

    var isLong = enhanced.length > 30;
    var bodyId = 'diff-' + (++diffIdCounter);

    return (
      '<div class="diff-block">' +
        '<div class="diff-header">' +
          (filePath ? '<span class="diff-filepath">' + escapeHtml(filePath) + '</span>' : '') +
          '<span class="diff-stats">+' + addCount + ' -' + delCount + '</span>' +
          (isLong ? '<button class="btn-diff-toggle" data-target="' + bodyId + '" title="Expand">&#9660;</button>' : '') +
        '</div>' +
        '<pre class="diff-body' + (isLong ? ' diff-collapsed' : '') + '" id="' + bodyId + '">' + linesHtml + '</pre>' +
      '</div>'
    );
  }

  function computeLineDiff(oldLines, newLines) {
    if (oldLines.length + newLines.length > 200) {
      var result = [];
      oldLines.forEach(function (l) { result.push({ type: 'del', text: l }); });
      newLines.forEach(function (l) { result.push({ type: 'add', text: l }); });
      return result;
    }
    var m = oldLines.length, n = newLines.length;
    var dp = [];
    for (var i = 0; i <= m; i++) {
      dp[i] = [];
      for (var j = 0; j <= n; j++) {
        if (i === 0 || j === 0) { dp[i][j] = 0; }
        else if (oldLines[i - 1] === newLines[j - 1]) { dp[i][j] = dp[i - 1][j - 1] + 1; }
        else { dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]); }
      }
    }
    var diff = [];
    var oi = m, ni = n;
    while (oi > 0 || ni > 0) {
      if (oi > 0 && ni > 0 && oldLines[oi - 1] === newLines[ni - 1]) {
        diff.unshift({ type: 'ctx', text: oldLines[oi - 1] });
        oi--; ni--;
      } else if (ni > 0 && (oi === 0 || dp[oi][ni - 1] >= dp[oi - 1][ni])) {
        diff.unshift({ type: 'add', text: newLines[ni - 1] });
        ni--;
      } else {
        diff.unshift({ type: 'del', text: oldLines[oi - 1] });
        oi--;
      }
    }
    return diff;
  }

  /**
   * Only auto-scroll if user is already near the bottom (within 150px).
   * Use scrollToBottom(true) to force-scroll regardless (e.g. user sent a prompt).
   */
  function scrollToBottom(force) {
    if (force || isNearBottom()) {
      $conversation.scrollTop = $conversation.scrollHeight;
    }
  }

  function isNearBottom() {
    var threshold = 150;
    return ($conversation.scrollHeight - $conversation.scrollTop - $conversation.clientHeight) < threshold;
  }

  // Reverse infinite scroll: load older messages when sentinel is visible
  var _loadMoreObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var inst = instances.get(activeInstanceId);
      if (inst && inst._loadedFrom > 0 && !inst._loadingOlder) {
        loadOlderMessages(inst);
      }
    });
  }, { root: $conversation, threshold: 0.1 });

  // Re-observe sentinel after each render
  var _prevSentinel = null;
  var _origRenderConversation = renderConversation;
  renderConversation = function (skipScroll) {
    _origRenderConversation(skipScroll);
    // Observe new sentinel if present
    if (_prevSentinel) _loadMoreObserver.unobserve(_prevSentinel);
    var sentinel = document.getElementById('load-more-sentinel');
    if (sentinel) {
      _loadMoreObserver.observe(sentinel);
      _prevSentinel = sentinel;
    }
  };

  // Diff collapse/expand toggle (delegated)
  $conversation.addEventListener('click', function (e) {
    var toggle = e.target.closest('.btn-diff-toggle');
    if (toggle) {
      var targetId = toggle.getAttribute('data-target');
      var body = document.getElementById(targetId);
      if (body) {
        body.classList.toggle('diff-collapsed');
        toggle.innerHTML = body.classList.contains('diff-collapsed') ? '&#9660;' : '&#9650;';
      }
    }
  });

  // ---- Actions ----
  /**
   * Send a user prompt.
   *
   * Renders the bubble locally BEFORE the server round-trip so the user
   * sees their own text the instant they press Enter. The server's
   * echo back over WebSocket is then matched to the optimistic bubble
   * via a client-generated UUID (`clientMsgId`) and reconciles
   * (replaces the pending entry with the server-stamped one) instead
   * of producing a second bubble.
   *
   * Why a client UUID and not just "match by content + timestamp":
   *   - Content can repeat verbatim (slash commands, retries) — content
   *     match would coalesce distinct messages.
   *   - Timestamps drift between client and server.
   *   - The UUID is uniquely paired and survives reconnection.
   *
   * If the server doesn't echo within OPTIMISTIC_TIMEOUT_MS the bubble
   * flips to a failed visual state so the user knows their send didn't
   * land. The seq dedup defended further down the pipeline still
   * catches duplicate-broadcast delivery from any future bug.
   */
  function sendPrompt() {
    var text = $promptInput.value.trim();
    if ((!text && pendingAttachments.length === 0) || !activeInstanceId) return;

    var attachments = pendingAttachments.map(function (a) {
      return { id: a.id, path: a.path, filename: a.filename, mediaType: a.mediaType };
    });
    var clientMsgId = newClientMsgId();
    var finalText = text || (attachments.length > 0 ? 'See attached file(s).' : '');

    // 1. Optimistic local insert. Bubble appears immediately.
    var optimisticMsg = {
      role: 'user',
      content: finalText,
      source: 'mobile',
      attachments: attachments,
      clientMsgId: clientMsgId,
      _pending: true,
      timestamp: Date.now(),
    };
    var inst = instances.get(activeInstanceId);
    if (inst) {
      if (!inst.conversation) inst.conversation = [];
      inst.conversation.push(optimisticMsg);
      if (!inst._firstPrompt) {
        inst._firstPrompt = finalText;
        renderList();
      }
      appendMessage(optimisticMsg);
    }

    // 2. Ship to server. The clientMsgId rides along so the server's
    //    echo can be matched to the optimistic bubble.
    send({
      type: 'send_prompt',
      instanceId: activeInstanceId,
      text: finalText,
      attachments: attachments,
      clientMsgId: clientMsgId,
    });

    // 3. Failure timeout: if the server hasn't echoed within the
    //    deadline, mark the bubble as failed so the user knows.
    scheduleOptimisticTimeout(activeInstanceId, clientMsgId);

    clearAttachments();
    $promptInput.value = '';
    $promptInput.style.height = 'auto';
    // Immediately disable send button to prevent double-send while we wait
    // for the server to mark the instance busy. Gets re-enabled via
    // updateSendButton() on the next renderDetail() trigger.
    $btnSend.disabled = true;
    scrollToBottom(true);
  }

  // -----  Optimistic-render plumbing  ----------------------------------

  var OPTIMISTIC_TIMEOUT_MS = 10000;
  var optimisticTimers = {};   // clientMsgId -> setTimeout handle

  /**
   * Generate a per-message UUID for client→server→client matching.
   * The format is human-recognizable in the network tab when debugging
   * (`cmsg-<base36 epoch>-<random>`); the recipient treats it as an
   * opaque string.
   */
  function newClientMsgId() {
    return 'cmsg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function scheduleOptimisticTimeout(instanceId, clientMsgId) {
    if (optimisticTimers[clientMsgId]) clearTimeout(optimisticTimers[clientMsgId]);
    optimisticTimers[clientMsgId] = setTimeout(function () {
      delete optimisticTimers[clientMsgId];
      var inst = instances.get(instanceId);
      if (!inst || !inst.conversation) return;
      // Walk backwards so we hit the most-recent pending first
      for (var i = inst.conversation.length - 1; i >= 0; i--) {
        var m = inst.conversation[i];
        if (m && m._pending && m.clientMsgId === clientMsgId) {
          m._pending = false;
          m._failed = true;
          markBubbleFailed(clientMsgId);
          break;
        }
      }
    }, OPTIMISTIC_TIMEOUT_MS);
  }

  function clearOptimisticTimeout(clientMsgId) {
    if (optimisticTimers[clientMsgId]) {
      clearTimeout(optimisticTimers[clientMsgId]);
      delete optimisticTimers[clientMsgId];
    }
  }

  /**
   * Targeted DOM update on confirmation: find the pending bubble by
   * its data-client-msg-id and drop the .msg-pending class. We don't
   * re-render the whole conversation because that would scroll-jitter
   * the user out of the bottom-pinned view.
   */
  function markBubbleConfirmed(clientMsgId) {
    var el = $conversation.querySelector('.msg[data-client-msg-id="' + cssEscape(clientMsgId) + '"]');
    if (el) {
      el.classList.remove('msg-pending');
      el.classList.add('msg-confirmed');
    }
  }

  function markBubbleFailed(clientMsgId) {
    var el = $conversation.querySelector('.msg[data-client-msg-id="' + cssEscape(clientMsgId) + '"]');
    if (el) {
      el.classList.remove('msg-pending');
      el.classList.add('msg-failed');
    }
  }

  /**
   * CSS.escape shim for older browsers (and our usage of it inside
   * attribute selectors). The clientMsgId charset is constrained but
   * we escape defensively to avoid selector-injection bugs.
   */
  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // ---- Mid-session model picker ----
  //
  // The detail-header pill shows the operator's last picked model for
  // this instance (defaulting to the model the session was created
  // with, when known). Clicking it opens a modal where they can pick a
  // preset or enter a custom id. Behaviour by agent:
  //
  //   - Claude: sends "/model <name>" as a regular prompt. Claude Code
  //     interprets that slash-command at the CLI level and switches the
  //     model for subsequent turns — no server changes required.
  //   - Everyone else: shows a warning that switching the model takes
  //     effect only after respawning the agent, and disables the apply
  //     button. The picker still lets the operator inspect the preset
  //     list, just without making a live change.
  var $detailModelPill = document.getElementById('detail-model');
  var $detailModelLabel = $detailModelPill && $detailModelPill.querySelector('.model-pill-label');
  var $detailModelValue = $detailModelPill && $detailModelPill.querySelector('.model-pill-value');
  var $detailOutboxPill = document.getElementById('detail-outbox');
  var $detailOutboxState = document.getElementById('outbox-pill-state');
  // Per-instance outbox state — server is authoritative; this is just a
  // local UI mirror keyed by instanceId so we don't refetch on every render.
  var instanceOutboxEnabled = {};

  function renderOutboxPill(inst) {
    if (!$detailOutboxPill) return;
    if (!inst || !inst.id) {
      $detailOutboxPill.classList.add('hidden');
      return;
    }
    $detailOutboxPill.classList.remove('hidden');
    var on = !!instanceOutboxEnabled[inst.id];
    if (on) {
      $detailOutboxPill.classList.add('outbox-on');
      $detailOutboxState.textContent = 'on';
    } else {
      $detailOutboxPill.classList.remove('outbox-on');
      $detailOutboxState.textContent = 'off';
    }
  }

  async function toggleOutbox() {
    var inst = instances.get(activeInstanceId);
    if (!inst) return;
    var nextOn = !instanceOutboxEnabled[inst.id];
    var endpoint = '/api/instances/' + encodeURIComponent(inst.id) + '/outbox/' + (nextOn ? 'enable' : 'disable');
    try {
      var resp = await fetch(endpoint, { method: 'POST', credentials: 'same-origin' });
      if (!resp.ok) throw new Error('http_' + resp.status);
      var data = await resp.json();
      instanceOutboxEnabled[inst.id] = !!data.enabled;
      renderOutboxPill(inst);
    } catch (err) {
      console.error('outbox toggle failed:', err);
    }
  }

  /**
   * Sync the outbox-enabled state for an instance from the server.
   * Called when the user opens an instance so the pill reflects truth
   * across reloads / multi-tab usage.
   */
  async function refreshOutboxState(instanceId) {
    if (!instanceId) return;
    try {
      var resp = await fetch('/api/instances/' + encodeURIComponent(instanceId) + '/outbox', {
        credentials: 'same-origin',
      });
      if (!resp.ok) return;
      var data = await resp.json();
      instanceOutboxEnabled[instanceId] = !!data.enabled;
      if (instances.has(instanceId)) renderOutboxPill(instances.get(instanceId));
    } catch (err) {
      // non-critical: leave pill in its current state
    }
  }

  if ($detailOutboxPill) {
    $detailOutboxPill.addEventListener('click', toggleOutbox);
  }

  // Delegated handler for outbox download chips. The chip carries the
  // instanceId + filename in data-* attributes so a single listener
  // covers chips on every rendered message.
  document.addEventListener('click', function (e) {
    var chip = e.target && e.target.closest && e.target.closest('.msg-outbox-chip');
    if (!chip) return;
    e.preventDefault();
    var iid = chip.getAttribute('data-instance-id');
    var name = chip.getAttribute('data-outbox-name');
    if (!iid || !name) return;
    // Open in a new tab so the browser's download UI handles auth +
    // save. credentials: 'include' isn't needed for a same-origin
    // navigation; the dashboard cookie/session ride along.
    var url = '/api/instances/' + encodeURIComponent(iid) + '/outbox/' + encodeURIComponent(name);
    window.location.href = url;
  });
  var $modelPickerModal = document.getElementById('model-picker-modal');
  var $modelPickerList = document.getElementById('model-picker-list');
  var $modelPickerCustom = document.getElementById('model-picker-custom');
  var $modelPickerHint = document.getElementById('model-picker-hint');
  var $modelPickerWarning = document.getElementById('model-picker-warning');
  var $modelPickerApply = document.getElementById('btn-model-picker-apply');
  var $btnCloseModelPicker = document.getElementById('btn-close-model-picker');
  var modelPickerSelected = '';

  function renderModelPill(inst, agentType) {
    if (!$detailModelPill) return;
    if (!inst || !inst.id) {
      $detailModelPill.classList.add('hidden');
      return;
    }
    var current = instanceModelHint[inst.id] != null ? instanceModelHint[inst.id] : (inst.model || '');
    $detailModelLabel.textContent = 'model';
    $detailModelValue.textContent = modelLabelFor(agentType, current);
    $detailModelPill.classList.remove('hidden');
    // Stash the agent type on the element so the click handler doesn't
    // have to re-derive it (and the modal picks the right preset list).
    $detailModelPill.dataset.agentType = agentType;
    $detailModelPill.dataset.current = current;
  }

  function openModelPicker() {
    var inst = instances.get(activeInstanceId);
    if (!inst || !$modelPickerModal) return;
    var agentType = ($detailModelPill && $detailModelPill.dataset.agentType) || inst.agentType || 'claude';
    var current = ($detailModelPill && $detailModelPill.dataset.current) || '';
    var spec = AGENT_MODELS[agentType] || AGENT_MODELS.claude;
    modelPickerSelected = current;

    // Populate the preset list as radio-like buttons
    $modelPickerList.replaceChildren();
    spec.presets.forEach(function (preset) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'model-picker-row' + (preset.id === current ? ' selected' : '');
      btn.dataset.modelId = preset.id;
      var label = document.createElement('span');
      label.className = 'model-picker-row-label';
      label.textContent = preset.label;
      btn.appendChild(label);
      if (preset.id === current) {
        var check = document.createElement('span');
        check.className = 'model-picker-row-check';
        check.textContent = '✓';
        btn.appendChild(check);
      }
      btn.addEventListener('click', function () {
        modelPickerSelected = preset.id;
        // Visually mark and clear other rows
        var rows = $modelPickerList.querySelectorAll('.model-picker-row');
        for (var i = 0; i < rows.length; i++) rows[i].classList.remove('selected');
        btn.classList.add('selected');
        $modelPickerCustom.value = '';
      });
      $modelPickerList.appendChild(btn);
    });
    // Pre-fill the custom field when the current model isn't a preset
    var isPreset = spec.presets.some(function (p) { return p.id === current; });
    $modelPickerCustom.value = isPreset ? '' : (current || '');

    // Hint + warning per agent capability
    if (spec.slashSwitch) {
      $modelPickerHint.textContent = 'This agent supports live model switching via a slash-command. The new model takes effect on the next prompt.';
      $modelPickerWarning.classList.add('hidden');
      $modelPickerApply.disabled = false;
      $modelPickerApply.textContent = 'Apply';
    } else {
      $modelPickerHint.textContent = 'This agent only accepts a model at startup, so switching mid-session is recorded locally only — you will need to start a new session for the change to take effect.';
      $modelPickerWarning.textContent = 'Heads up: the running agent will continue using its current model. Use the new-session button (＋) to actually switch.';
      $modelPickerWarning.classList.remove('hidden');
      $modelPickerApply.disabled = false;
      $modelPickerApply.textContent = 'Remember this choice';
    }

    $modelPickerModal.classList.remove('hidden');
    requestAnimationFrame(function () { $modelPickerModal.classList.add('visible'); });
    setTimeout(function () { $modelPickerCustom.focus(); }, 350);
  }

  function applyModelPicker() {
    var inst = instances.get(activeInstanceId);
    if (!inst || !$modelPickerModal) return;
    var agentType = ($detailModelPill && $detailModelPill.dataset.agentType) || inst.agentType || 'claude';
    var spec = AGENT_MODELS[agentType] || AGENT_MODELS.claude;

    // Custom input wins when present (lets the operator override any
    // selected preset by typing).
    var modelId = $modelPickerCustom.value.trim() || modelPickerSelected;
    // Empty string is valid — means "back to default" — but the slash
    // path can't express that, so for claude we treat empty as "no-op".
    if (spec.slashSwitch && modelId) {
      // Send "/model <id>" via the existing prompt API. The agent's
      // stdin handler routes any text to claude; the slash command is
      // interpreted by Claude Code itself.
      send({
        type: 'send_prompt',
        instanceId: inst.id,
        text: (spec.slashCommand || '/model') + ' ' + modelId,
        attachments: [],
      });
    }
    // Update the local hint regardless of agent type — the operator
    // explicitly picked this, so the pill should reflect that even when
    // the underlying agent won't honour it until respawn.
    instanceModelHint[inst.id] = modelId;
    renderModelPill(inst, agentType);
    closeModelPicker();
  }

  function closeModelPicker() {
    if (!$modelPickerModal) return;
    $modelPickerModal.classList.remove('visible');
    setTimeout(function () { $modelPickerModal.classList.add('hidden'); }, 300);
  }

  if ($detailModelPill) {
    $detailModelPill.addEventListener('click', openModelPicker);
  }
  if ($modelPickerApply) {
    $modelPickerApply.addEventListener('click', applyModelPicker);
  }
  if ($btnCloseModelPicker) {
    $btnCloseModelPicker.addEventListener('click', closeModelPicker);
  }
  if ($modelPickerModal) {
    $modelPickerModal.addEventListener('click', function (e) {
      if (e.target === $modelPickerModal) closeModelPicker();
    });
  }
  if ($modelPickerCustom) {
    // Custom text wins; clear the highlighted preset row when typing.
    $modelPickerCustom.addEventListener('input', function () {
      if ($modelPickerCustom.value.trim()) {
        var rows = $modelPickerList.querySelectorAll('.model-picker-row');
        for (var i = 0; i < rows.length; i++) rows[i].classList.remove('selected');
        modelPickerSelected = '';
      }
    });
  }

  // ---- Template Bar ----
  var $templateBar = document.getElementById('template-bar');

  function renderTemplateBar() {
    var inst = instances.get(activeInstanceId);
    if (!inst) { $templateBar.classList.add('hidden'); return; }
    var agentType = inst.agentType || 'claude';
    var all = DEFAULT_TEMPLATES.concat(customTemplates);
    var filtered = all.filter(function (t) {
      if (!t.agents || t.agents.length === 0) return true;
      return t.agents.indexOf(agentType) !== -1;
    });
    if (filtered.length === 0) { $templateBar.classList.add('hidden'); return; }
    $templateBar.classList.remove('hidden');
    $templateBar.innerHTML = filtered.map(function (t) {
      var isCustom = !DEFAULT_TEMPLATES.some(function (d) { return d.id === t.id; });
      return '<button class="template-btn' + (isCustom ? ' template-custom' : '') + '" ' +
        'data-template-text="' + escapeHtml(t.text).replace(/"/g, '&quot;') + '">' +
        escapeHtml(t.label) + '</button>';
    }).join('') +
    '<button class="template-btn template-add" title="Add custom template">+</button>';
  }

  $templateBar.addEventListener('click', function (e) {
    var btn = e.target.closest('.template-btn');
    if (!btn) return;
    if (btn.classList.contains('template-add')) {
      var label = prompt('Template name (max 40 chars):');
      if (!label) return;
      label = label.trim().slice(0, 40);
      if (!label) return;
      var text = prompt('Template text (max 500 chars):');
      if (!text) return;
      text = text.trim().slice(0, MAX_TEMPLATE_LENGTH);
      if (!text) return;
      customTemplates.push({ id: 'custom-' + Date.now(), label: label, text: text, agents: [] });
      saveCustomTemplates(customTemplates);
      renderTemplateBar();
      return;
    }
    var text = btn.getAttribute('data-template-text');
    if (!text) return;
    $promptInput.value = text;
    $promptInput.style.height = 'auto';
    $promptInput.style.height = Math.min($promptInput.scrollHeight, 120) + 'px';
    updateSendButton();
    $promptInput.focus();
  });

  $templateBar.addEventListener('contextmenu', function (e) {
    var btn = e.target.closest('.template-custom');
    if (!btn) return;
    e.preventDefault();
    var text = btn.getAttribute('data-template-text');
    if (confirm('Remove this custom template?')) {
      customTemplates = customTemplates.filter(function (t) { return t.text !== text; });
      saveCustomTemplates(customTemplates);
      renderTemplateBar();
    }
  });

  function updateSendButton() {
    var hasContent = $promptInput.value.trim() || pendingAttachments.length > 0;
    $btnSend.disabled = !hasContent;
  }

  function takeover(instanceId) {
    $btnTakeover.disabled = true;
    $btnTakeover.textContent = 'Taking over...';
    authFetch('/api/instances/' + instanceId + '/takeover', { method: 'POST' })
      .then(function (r) {
        if (!r.ok) {
          return r.json().then(function (err) {
            throw new Error(err.error || 'Takeover failed (' + r.status + ')');
          });
        }
        return r.json();
      })
      .then(function (result) {
        if (result.instanceId) {
          var tryOpen = function (attempts) {
            if (instances.has(result.instanceId)) {
              openDetail(result.instanceId);
            } else if (attempts > 0) {
              setTimeout(function () { tryOpen(attempts - 1); }, 500);
            } else {
              // Polling exhausted — force refresh instances and retry once
              authFetch('/api/instances').then(function (r) { return r.json(); }).then(function (list) {
                list.forEach(function (inst) {
                  inst.conversation = inst.conversation || [];
                  inst._firstPrompt = inst.firstPrompt || null;
                  instances.set(inst.id, inst);
                });
                if (instances.has(result.instanceId)) {
                  openDetail(result.instanceId);
                } else {
                  $btnTakeover.disabled = false;
                  $btnTakeover.textContent = 'Take Over Session';
                  alert('Takeover succeeded but the new instance did not appear. Try again.');
                }
              }).catch(function () {
                $btnTakeover.disabled = false;
                $btnTakeover.textContent = 'Take Over Session';
              });
            }
          };
          tryOpen(6);
        } else {
          throw new Error(result.error || 'No instance returned');
        }
      })
      .catch(function (err) {
        $btnTakeover.disabled = false;
        $btnTakeover.textContent = 'Take Over Session';
        if (err.message !== 'Unauthorized') {
          alert('Takeover failed: ' + err.message);
        }
      });
  }

  // ---- Event Listeners ----
  $btnBack.addEventListener('click', closeDetail);

  $btnSend.addEventListener('click', function () {
    if (recognition && isRecording) stopRecording();
    sendPrompt();
  });

  // ---- Voice Input ----
  var $btnMic = document.getElementById('btn-mic');
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recognition = null;
  var isRecording = false;

  if (SpeechRecognition) {
    $btnMic.classList.remove('hidden');
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onresult = function (event) {
      var transcript = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          transcript += event.results[i][0].transcript;
        }
      }
      if (transcript) {
        $promptInput.value += ($promptInput.value ? ' ' : '') + transcript;
        $promptInput.style.height = 'auto';
        $promptInput.style.height = Math.min($promptInput.scrollHeight, 120) + 'px';
        updateSendButton();
      }
    };
    recognition.onerror = function (event) {
      stopRecording();
      var errMsg = event.error || 'unknown error';
      if (errMsg === 'not-allowed') {
        alert('Microphone access denied. Speech recognition requires HTTPS (or localhost).');
      } else if (errMsg === 'no-speech') {
        // Silence — no alert needed
      } else {
        alert('Speech recognition error: ' + errMsg);
      }
    };
    recognition.onend = function () { if (isRecording) stopRecording(); };
  }

  function startRecording() {
    if (!recognition) return;
    isRecording = true;
    $btnMic.classList.add('recording');
    $promptInput.classList.add('recording');
    recognition.start();
  }

  function stopRecording() {
    if (!recognition) return;
    isRecording = false;
    $btnMic.classList.remove('recording');
    $promptInput.classList.remove('recording');
    try { recognition.stop(); } catch (e) {}
  }

  $btnMic.addEventListener('click', function () {
    if (isRecording) stopRecording();
    else startRecording();
  });

  $btnTakeover.addEventListener('click', function () {
    if (activeInstanceId) takeover(activeInstanceId);
  });

  $btnTakeoverAbort.addEventListener('click', function () {
    if (!activeInstanceId) return;
    $btnTakeoverAbort.disabled = true;
    $btnTakeoverAbort.textContent = 'Aborting...';
    // Try to abort the running task, then take over regardless.
    // For auto-discovered instances the abort may fail (no agent socket),
    // but takeover with --resume will start a new process anyway.
    authFetch('/api/instances/' + activeInstanceId + '/abort', { method: 'POST' })
      .finally(function () {
        setTimeout(function () {
          takeover(activeInstanceId);
        }, 1000);
      });
  });

  $btnTakeoverWait.addEventListener('click', function () {
    if (!activeInstanceId) return;
    var instId = activeInstanceId;
    $btnTakeoverWait.disabled = true;
    $btnTakeoverWait.textContent = 'Waiting...';
    // Poll until idle, then auto-takeover
    var waitTimer = setInterval(function () {
      var inst = instances.get(instId);
      if (!inst || inst.status !== 'busy') {
        clearInterval(waitTimer);
        $btnTakeoverWait.disabled = false;
        $btnTakeoverWait.textContent = 'Wait for Idle';
        if (inst && instId === activeInstanceId) {
          takeover(instId);
        }
      }
    }, 1000);
  });

  $btnAbort.addEventListener('click', function () {
    if (activeInstanceId && confirm('Abort current task?')) {
      send({ type: 'abort', instanceId: activeInstanceId });
    }
  });

  $btnApprove.addEventListener('click', function () {
    if (activeInstanceId) {
      // Optimistic UI: hide banner immediately
      var inst = instances.get(activeInstanceId);
      if (inst) {
        inst.pendingApproval = null;
        inst.status = 'busy';
      }
      renderDetail();
      authFetch('/api/instances/' + activeInstanceId + '/approve', { method: 'POST' })
        .catch(function () {});
    }
  });

  $btnApproveAll.addEventListener('click', function () {
    if (activeInstanceId) {
      // Optimistic UI: set auto-approve and hide banner
      var inst = instances.get(activeInstanceId);
      if (inst) {
        inst.autoApprove = true;
        inst.pendingApproval = null;
        inst.status = 'busy';
      }
      renderDetail();
      authFetch('/api/instances/' + activeInstanceId + '/auto-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: true }),
      }).catch(function () {});
    }
  });

  $btnReject.addEventListener('click', function () {
    if (activeInstanceId) {
      var inst = instances.get(activeInstanceId);
      if (inst) {
        inst.pendingApproval = null;
        inst.status = 'busy';
      }
      renderDetail();
      authFetch('/api/instances/' + activeInstanceId + '/reject', { method: 'POST' })
        .catch(function () {});
    }
  });

  // ---- Swipe Gestures on Approval Banner ----
  (function () {
    var startX = 0, startY = 0, swiping = false, swipeDebounce = false;
    $approvalBanner.addEventListener('touchstart', function (e) {
      if (swipeDebounce) return;
      var t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      swiping = true;
      $approvalBanner.style.transition = 'none';
    });
    $approvalBanner.addEventListener('touchmove', function (e) {
      if (!swiping) return;
      var t = e.touches[0];
      var deltaX = t.clientX - startX;
      var deltaY = t.clientY - startY;
      if (Math.abs(deltaY) > Math.abs(deltaX)) { swiping = false; $approvalBanner.style.transform = ''; return; }
      e.preventDefault();
      $approvalBanner.style.transform = 'translateX(' + deltaX + 'px)';
      $approvalBanner.style.opacity = Math.max(0.3, 1 - Math.abs(deltaX) / $approvalBanner.offsetWidth);
    }, { passive: false });
    $approvalBanner.addEventListener('touchend', function (e) {
      if (!swiping) return;
      swiping = false;
      var t = e.changedTouches[0];
      var deltaX = t.clientX - startX;
      var threshold = $approvalBanner.offsetWidth * 0.3;
      $approvalBanner.style.transition = 'transform 0.2s, opacity 0.2s';
      if (deltaX > threshold && activeInstanceId) {
        // Swipe right = approve
        swipeDebounce = true;
        $approvalBanner.style.transform = 'translateX(100%)';
        $approvalBanner.style.opacity = '0';
        if (navigator.vibrate) navigator.vibrate(50);
        setTimeout(function () {
          $btnApprove.click();
          $approvalBanner.style.transform = '';
          $approvalBanner.style.opacity = '';
          swipeDebounce = false;
        }, 200);
      } else if (deltaX < -threshold && activeInstanceId) {
        // Swipe left = reject
        swipeDebounce = true;
        $approvalBanner.style.transform = 'translateX(-100%)';
        $approvalBanner.style.opacity = '0';
        if (navigator.vibrate) navigator.vibrate(50);
        setTimeout(function () {
          $btnReject.click();
          $approvalBanner.style.transform = '';
          $approvalBanner.style.opacity = '';
          swipeDebounce = false;
        }, 200);
      } else {
        $approvalBanner.style.transform = '';
        $approvalBanner.style.opacity = '';
      }
    });
  })();

  // Plan banner handlers
  $btnPlanToggle.addEventListener('click', function () {
    $planContent.classList.toggle('collapsed');
    $btnPlanToggle.innerHTML = $planContent.classList.contains('collapsed') ? '&#9660;' : '&#9650;';
  });

  $btnPlanApprove.addEventListener('click', function () {
    if (activeInstanceId) {
      var inst = instances.get(activeInstanceId);
      if (inst) {
        inst.pendingApproval = null;
        inst.status = 'busy';
      }
      renderDetail();
      authFetch('/api/instances/' + activeInstanceId + '/approve', { method: 'POST' })
        .catch(function () {});
    }
  });

  $btnPlanReject.addEventListener('click', function () {
    if (activeInstanceId) {
      var inst = instances.get(activeInstanceId);
      if (inst) {
        inst.pendingApproval = null;
        inst.status = 'busy';
      }
      renderDetail();
      authFetch('/api/instances/' + activeInstanceId + '/reject', { method: 'POST' })
        .catch(function () {});
    }
  });

  // Question banner handlers
  $btnQuestionSubmit.addEventListener('click', function () {
    if (!activeInstanceId) return;
    var answers = collectAnswers();
    var inst = instances.get(activeInstanceId);
    if (inst) {
      inst.pendingApproval = null;
      inst.status = 'busy';
    }
    renderDetail();
    authFetch('/api/instances/' + activeInstanceId + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: answers }),
    }).catch(function () {});
  });

  $btnQuestionReject.addEventListener('click', function () {
    if (activeInstanceId) {
      var inst = instances.get(activeInstanceId);
      if (inst) {
        inst.pendingApproval = null;
        inst.status = 'busy';
      }
      renderDetail();
      authFetch('/api/instances/' + activeInstanceId + '/reject', { method: 'POST' })
        .catch(function () {});
    }
  });

  $btnStopAutoApprove.addEventListener('click', function () {
    if (activeInstanceId) {
      var inst = instances.get(activeInstanceId);
      if (inst) inst.autoApprove = false;
      renderDetail();
      authFetch('/api/instances/' + activeInstanceId + '/auto-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: false }),
      }).catch(function () {});
    }
  });

  $promptInput.addEventListener('input', function () {
    updateSendButton();
    // Auto-resize
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  $promptInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  // ---- Attachments ----
  $btnAttach.addEventListener('click', function () {
    $fileInput.click();
  });

  $fileInput.addEventListener('change', function () {
    var files = Array.from(this.files);
    this.value = ''; // reset so same file can be picked again
    files.forEach(function (file) {
      uploadFile(file);
    });
  });

  // Paste images straight from the clipboard. Listens on the prompt
  // input so it only fires while the user is composing a message;
  // attaching on document would intercept paste in other contexts.
  // Browsers expose pasted images as File objects via
  // event.clipboardData.items[i].getAsFile() with type 'image/*'.
  // Text paste keeps its default behaviour (we only preventDefault
  // when at least one image was found).
  $promptInput.addEventListener('paste', function (e) {
    if (!e.clipboardData || !e.clipboardData.items) return;
    var images = [];
    for (var i = 0; i < e.clipboardData.items.length; i++) {
      var item = e.clipboardData.items[i];
      if (item && item.kind === 'file' && item.type && item.type.indexOf('image/') === 0) {
        var blob = item.getAsFile();
        if (blob) images.push(blob);
      }
    }
    if (images.length === 0) return; // let the browser handle text paste
    e.preventDefault();
    images.forEach(function (blob) {
      // Pasted images come without a real filename. Give them a
      // deterministic-ish one so the server-side sanitizer is happy.
      var ext = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase();
      var stamped = new File(
        [blob],
        'pasted-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + ext,
        { type: blob.type, lastModified: Date.now() }
      );
      uploadFile(stamped);
    });
  });

  function uploadFile(file) {
    if (file.size > 10 * 1024 * 1024) {
      alert('File too large (max 10MB): ' + file.name);
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      var base64 = reader.result.split(',')[1]; // strip data:...;base64, prefix
      authFetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          mediaType: file.type || 'application/octet-stream',
          data: base64,
        }),
      })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        var att = {
          id: result.id,
          path: result.path,
          filename: result.filename,
          mediaType: result.mediaType,
          previewUrl: file.type && file.type.startsWith('image/')
            ? URL.createObjectURL(file) : null,
          serverFilename: result.path.split('/').pop(),
        };
        pendingAttachments.push(att);
        renderAttachmentPreview();
        updateSendButton();
      })
      .catch(function () {
        alert('Upload failed: ' + file.name);
      });
    };
    reader.readAsDataURL(file);
  }

  function renderAttachmentPreview() {
    if (pendingAttachments.length === 0) {
      $attachmentPreview.classList.add('hidden');
      $attachmentPreview.innerHTML = '';
      return;
    }

    $attachmentPreview.classList.remove('hidden');
    $attachmentPreview.innerHTML = pendingAttachments.map(function (att, idx) {
      if (att.previewUrl) {
        return (
          '<div class="attachment-chip" data-idx="' + idx + '">' +
            '<img class="attachment-thumb" src="' + att.previewUrl + '" alt="' + escapeHtml(att.filename) + '">' +
            '<span class="attachment-name">' + escapeHtml(att.filename) + '</span>' +
            '<button class="attachment-remove" data-idx="' + idx + '">&times;</button>' +
          '</div>'
        );
      }
      return (
        '<div class="attachment-chip" data-idx="' + idx + '">' +
          '<span class="attachment-icon">&#128196;</span>' +
          '<span class="attachment-name">' + escapeHtml(att.filename) + '</span>' +
          '<button class="attachment-remove" data-idx="' + idx + '">&times;</button>' +
        '</div>'
      );
    }).join('');

    // Attach remove handlers
    var removeButtons = $attachmentPreview.querySelectorAll('.attachment-remove');
    for (var i = 0; i < removeButtons.length; i++) {
      removeButtons[i].addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = parseInt(e.currentTarget.getAttribute('data-idx'));
        removeAttachment(idx);
      });
    }
  }

  function removeAttachment(idx) {
    var att = pendingAttachments[idx];
    if (att && att.previewUrl) {
      URL.revokeObjectURL(att.previewUrl);
    }
    pendingAttachments.splice(idx, 1);
    renderAttachmentPreview();
    updateSendButton();
  }

  function clearAttachments() {
    pendingAttachments.forEach(function (att) {
      if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    });
    pendingAttachments = [];
    renderAttachmentPreview();
  }

  // ---- Questions ----
  function renderQuestions(questions) {
    $questionList.innerHTML = questions.map(function (q, qi) {
      var inputType = q.multiSelect ? 'checkbox' : 'radio';
      var optionsHtml = (q.options || []).map(function (opt, oi) {
        var inputName = 'q' + qi;
        var inputId = 'q' + qi + '_o' + oi;
        return (
          '<label class="question-option" for="' + inputId + '">' +
            '<input type="' + inputType + '" name="' + inputName + '" id="' + inputId + '" value="' + escapeHtml(opt.label) + '">' +
            '<div class="option-content">' +
              '<span class="option-label">' + escapeHtml(opt.label) + '</span>' +
              (opt.description ? '<span class="option-desc">' + escapeHtml(opt.description) + '</span>' : '') +
            '</div>' +
          '</label>'
        );
      }).join('');
      // "Other" free-text option
      var otherId = 'q' + qi + '_other';
      optionsHtml += (
        '<label class="question-option" for="' + otherId + '">' +
          '<input type="' + inputType + '" name="q' + qi + '" id="' + otherId + '" value="__other__">' +
          '<div class="option-content">' +
            '<span class="option-label">Other</span>' +
            '<input type="text" class="other-text" id="' + otherId + '_text" placeholder="Type your answer..." disabled>' +
          '</div>' +
        '</label>'
      );
      return (
        '<div class="question-item" data-qi="' + qi + '" data-multi="' + (q.multiSelect ? '1' : '0') + '" data-question="' + escapeHtml(q.question) + '">' +
          (q.header ? '<div class="question-tag">' + escapeHtml(q.header) + '</div>' : '') +
          '<div class="question-text">' + escapeHtml(q.question) + '</div>' +
          '<div class="question-options">' + optionsHtml + '</div>' +
        '</div>'
      );
    }).join('');

    // Enable/disable "Other" text input based on selection
    var otherInputs = $questionList.querySelectorAll('input[value="__other__"]');
    for (var i = 0; i < otherInputs.length; i++) {
      (function (radio) {
        var textInput = document.getElementById(radio.id + '_text');
        // Listen to all radios in the same group
        var name = radio.name;
        var allInGroup = $questionList.querySelectorAll('input[name="' + name + '"]');
        for (var j = 0; j < allInGroup.length; j++) {
          allInGroup[j].addEventListener('change', function () {
            textInput.disabled = !radio.checked;
            if (radio.checked) textInput.focus();
          });
        }
      })(otherInputs[i]);
    }
  }

  function collectAnswers() {
    var answers = {};
    var items = $questionList.querySelectorAll('.question-item');
    for (var i = 0; i < items.length; i++) {
      var questionText = items[i].getAttribute('data-question') || items[i].getAttribute('data-qi');
      var isMulti = items[i].getAttribute('data-multi') === '1';
      var checked = items[i].querySelectorAll('input:checked');
      var values = [];
      for (var j = 0; j < checked.length; j++) {
        var val = checked[j].value;
        if (val === '__other__') {
          var textInput = document.getElementById(checked[j].id + '_text');
          val = textInput ? textInput.value.trim() : '';
        }
        if (val) values.push(val);
      }
      answers[questionText] = isMulti ? values.join(', ') : (values[0] || '');
    }
    return answers;
  }

  // ---- Plan Markdown ----
  function renderPlanMarkdown(str) {
    var escaped = escapeHtml(str);

    // Code blocks: ```lang\n...\n``` -> <pre><code>...</code></pre>
    escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, function (match, lang, code) {
      return '<pre class="plan-code-block"><code>' + code.replace(/\n$/, '') + '</code></pre>';
    });

    // Tables: detect lines with | separators
    escaped = escaped.replace(/((?:^|\n)\|.+\|(?:\n\|.+\|)+)/g, function (block) {
      var rows = block.trim().split('\n');
      var html = '<table class="plan-table">';
      var isHeader = true;
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r].trim();
        if (!row.startsWith('|')) continue;
        // Skip separator row (|---|---|)
        if (/^\|[\s\-:|]+\|$/.test(row)) {
          isHeader = false;
          continue;
        }
        var cells = row.split('|').filter(function (c, i, arr) {
          return i > 0 && i < arr.length - 1;
        });
        var tag = isHeader ? 'th' : 'td';
        html += '<tr>' + cells.map(function (c) {
          return '<' + tag + '>' + c.trim() + '</' + tag + '>';
        }).join('') + '</tr>';
        if (isHeader && r === 0) isHeader = true; // keep header until separator
      }
      html += '</table>';
      return html;
    });

    // Headers: ## ... -> <h3>, ### ... -> <h4>, etc
    escaped = escaped.replace(/^#{4,}\s+(.+)$/gm, '<h5 class="plan-h">$1</h5>');
    escaped = escaped.replace(/^###\s+(.+)$/gm, '<h4 class="plan-h">$1</h4>');
    escaped = escaped.replace(/^##\s+(.+)$/gm, '<h3 class="plan-h">$1</h3>');
    escaped = escaped.replace(/^#\s+(.+)$/gm, '<h3 class="plan-h plan-h1">$1</h3>');

    // Bold: **...** -> <strong>
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Inline code: `...` -> <code>
    escaped = escaped.replace(/`([^`\n]+)`/g, '<code class="plan-inline-code">$1</code>');

    // Bullet lists: lines starting with - or *
    escaped = escaped.replace(/^[\-\*]\s+(.+)$/gm, '<div class="plan-bullet">$1</div>');

    // Numbered lists
    escaped = escaped.replace(/^(\d+)\.\s+(.+)$/gm, '<div class="plan-numbered"><span class="plan-num">$1.</span> $2</div>');

    return escaped;
  }

  // ---- Helpers ----
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function renderMarkdown(str) {
    var escaped = escapeHtml(str);

    // 1. Extract code blocks to protect their contents
    var codeBlocks = [];
    escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, function (match, lang, code) {
      var idx = codeBlocks.length;
      codeBlocks.push(
        '<pre class="code-block"' + (lang ? ' data-lang="' + lang + '"' : '') + '>' +
        (lang ? '<div class="code-lang">' + lang + '</div>' : '') +
        '<code>' + code.replace(/\n$/, '') + '</code></pre>'
      );
      return '\x00CB' + idx + '\x00';
    });

    // 2. Extract inline code
    var inlineCodes = [];
    escaped = escaped.replace(/`([^`\n]+)`/g, function (match, code) {
      var idx = inlineCodes.length;
      inlineCodes.push('<code class="code-inline">' + code + '</code>');
      return '\x00IC' + idx + '\x00';
    });

    // 3. Tables
    escaped = escaped.replace(/((?:^|\n)\|.+\|(?:\n\|.+\|)+)/g, function (block) {
      var rows = block.trim().split('\n');
      var html = '<table class="md-table">';
      var isHeader = true;
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r].trim();
        if (!row.startsWith('|')) continue;
        if (/^\|[\s\-:|]+\|$/.test(row)) { isHeader = false; continue; }
        var cells = row.split('|').filter(function (c, i, arr) { return i > 0 && i < arr.length - 1; });
        var tag = isHeader ? 'th' : 'td';
        html += '<tr>' + cells.map(function (c) { return '<' + tag + '>' + c.trim() + '</' + tag + '>'; }).join('') + '</tr>';
        if (isHeader && r === 0) isHeader = true;
      }
      html += '</table>';
      return html;
    });

    // 4. Headers
    escaped = escaped.replace(/^####\s+(.+)$/gm, '<div class="md-h md-h4">$1</div>');
    escaped = escaped.replace(/^###\s+(.+)$/gm, '<div class="md-h md-h3">$1</div>');
    escaped = escaped.replace(/^##\s+(.+)$/gm, '<div class="md-h md-h2">$1</div>');
    escaped = escaped.replace(/^#\s+(.+)$/gm, '<div class="md-h md-h1">$1</div>');

    // 5. Horizontal rules
    escaped = escaped.replace(/^[-*_]{3,}$/gm, '<hr class="md-hr">');

    // 6. Blockquotes (> is escaped to &gt;)
    escaped = escaped.replace(/^&gt;\s+(.+)$/gm, '<div class="md-blockquote">$1</div>');

    // 7. Bold + italic
    escaped = escaped.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');

    // 8. Bold
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // 9. Italic
    escaped = escaped.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

    // 10. Strikethrough
    escaped = escaped.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // 11. Links [text](url) — unescape &amp; back to & in href; block unsafe protocols
    escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (match, text, url) {
      var href = url.replace(/&amp;/g, '&');
      if (!/^https?:\/\/|^mailto:/i.test(href)) return text;
      return '<a href="' + href + '" target="_blank" rel="noopener" class="md-link">' + text + '</a>';
    });

    // 12. Bullet lists
    escaped = escaped.replace(/^[\-\*]\s+(.+)$/gm, '<div class="md-bullet"><span class="md-bullet-dot"></span>$1</div>');

    // 13. Numbered lists
    escaped = escaped.replace(/^(\d+)\.\s+(.+)$/gm, '<div class="md-numbered"><span class="md-num">$1.</span> $2</div>');

    // 14. Arrow
    escaped = escaped.replace(/→/g, '<span class="arrow">→</span>');

    // 15. Restore inline code
    escaped = escaped.replace(/\x00IC(\d+)\x00/g, function (match, idx) {
      return inlineCodes[parseInt(idx)];
    });

    // 16. Restore code blocks
    escaped = escaped.replace(/\x00CB(\d+)\x00/g, function (match, idx) {
      return codeBlocks[parseInt(idx)];
    });

    return escaped;
  }

  function formatTime(ts) {
    var d = new Date(ts);
    var h = d.getHours().toString().padStart(2, '0');
    var m = d.getMinutes().toString().padStart(2, '0');
    return h + ':' + m;
  }

  // ---- Past Sessions ----
  function loadSessions() {
    showLoading($sessionsList, 'Loading sessions...');
    authFetch('/api/sessions?days=7&limit=30')
      .then(function (r) { return r.json(); })
      .then(function (sessions) {
        pastSessions = sessions;
        renderSessions();
        // Hide empty state if we have sessions to show
        if (pastSessions.length > 0 && instances.size === 0) {
          $emptyState.classList.add('hidden');
        }
      })
      .catch(function () {});
  }

  function renderSessions() {
    // Filter out sessions that are already active as instances
    var activeSessionIds = new Set();
    var activeCwdPrompts = new Set();
    instances.forEach(function (inst) {
      if (inst.sessionId) activeSessionIds.add(inst.sessionId);
      // Secondary dedup: match by cwd + firstPrompt (catches pre-sessionId window)
      if (inst.cwd && inst._firstPrompt) {
        activeCwdPrompts.add(inst.cwd + '\0' + inst._firstPrompt);
      }
    });

    var filtered = pastSessions.filter(function (s) {
      if (activeSessionIds.has(s.sessionId)) return false;
      if (s.cwd && s.firstPrompt && activeCwdPrompts.has(s.cwd + '\0' + s.firstPrompt)) return false;
      return true;
    });

    if (filtered.length === 0) {
      $sessionsSection.classList.add('hidden');
      return;
    }

    $sessionsSection.classList.remove('hidden');

    $sessionsList.innerHTML = filtered.map(function (s) {
      var ago = timeAgo(s.lastActivity);
      var title = s.firstPrompt
        ? (s.firstPrompt.length > 60 ? s.firstPrompt.slice(0, 60) + '...' : s.firstPrompt)
        : s.slug || s.project;
      var sessionAgentType = VALID_AGENT_TYPES.indexOf(s.agentType) !== -1 ? s.agentType : 'claude';
      return (
        '<div class="instance-card session-card" data-session-id="' + escapeHtml(s.sessionId) + '" data-cwd="' + escapeHtml(s.cwd || '') + '" data-project="' + escapeHtml(s.project) + '" data-agent-type="' + sessionAgentType + '">' +
          '<div class="card-top">' +
            '<span class="card-name">' + escapeHtml(title) + '</span>' +
            '<span class="badge badge-session">' + ago + '</span>' +
          '</div>' +
          '<div class="card-meta">' +
            '<span>' + escapeHtml(s.project) + '</span>' +
            '<span class="agent-badge agent-' + sessionAgentType + '">' + agentLabel(sessionAgentType) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    var cards = $sessionsList.querySelectorAll('.session-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener('click', onSessionCardClick);
    }
  }

  function onSessionCardClick(e) {
    var card = e.currentTarget;
    var sessionId = card.getAttribute('data-session-id');
    var cwd = card.getAttribute('data-cwd');
    var project = card.getAttribute('data-project');
    var agentType = card.getAttribute('data-agent-type') || 'claude';
    resumeSession(sessionId, cwd, project, agentType);
  }

  function resumeSession(sessionId, cwd, project, agentType) {
    // Show loading state on the card
    var card = $sessionsList.querySelector('[data-session-id="' + sessionId + '"]');
    if (card) {
      card.classList.add('resuming');
      card.innerHTML = '<div class="card-top"><span class="card-name">' + escapeHtml(project) + '</span><span class="badge badge-busy">loading...</span></div>';
    }

    // Fetch history and resume in parallel
    var historyPromise = authFetch('/api/sessions/' + sessionId + '/history')
      .then(function (r) { return r.json(); })
      .catch(function () { return []; });

    var resumePromise = authFetch('/api/sessions/' + sessionId + '/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: project, cwd: cwd, agentType: agentType || 'claude' }),
    })
    .then(function (r) { return r.json(); })
    .catch(function () { return {}; });

    Promise.all([historyPromise, resumePromise])
    .then(function (results) {
      var history = results[0];
      var resumeResult = results[1];

      if (resumeResult.instanceId) {
        // Wait for the instance to appear, then inject history and open
        var tryOpen = function (attempts) {
          if (instances.has(resumeResult.instanceId)) {
            var inst = instances.get(resumeResult.instanceId);
            // Prepend history before any new messages
            if (history.length > 0) {
              inst.conversation = history.concat(inst.conversation || []);
            }
            openDetail(resumeResult.instanceId);
          } else if (attempts > 0) {
            setTimeout(function () { tryOpen(attempts - 1); }, 500);
          }
        };
        tryOpen(6);
      } else if (resumeResult.error) {
        if (card) {
          card.classList.remove('resuming');
          card.innerHTML = '<div class="card-top"><span class="card-name">' + escapeHtml(project) + '</span><span class="badge badge-disconnected">error</span></div>';
        }
      }
    });
  }

  function timeAgo(ts) {
    if (!ts) return '';
    var diff = Date.now() - new Date(ts).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }

  $btnRefreshSessions.addEventListener('click', loadSessions);

  // ---- Virtual Keyboard / Viewport ----
  // On mobile, the virtual keyboard resizes the visual viewport.
  // Adjust the body height so flex layout stays correct.
  if (window.visualViewport) {
    var onViewportResize = function () {
      document.body.style.height = window.visualViewport.height + 'px';
      if (activeInstanceId) scrollToBottom(true);
    };
    window.visualViewport.addEventListener('resize', onViewportResize);
    window.visualViewport.addEventListener('scroll', onViewportResize);
  }

  // ---- New Session Modal ----
  function openNewSessionModal() {
    $newSessionModal.classList.remove('hidden');
    // Trigger reflow so the transition starts from the initial state
    void $newSessionModal.offsetHeight;
    $newSessionModal.classList.add('visible');
    $newSessionError.classList.add('hidden');
    $newCwd.value = '';
    $newCwd.classList.remove('error');
    $newName.value = '';
    $newModel.value = '';
    selectedAgentType = 'claude';
    updateAgentTypeSelection();
    $btnCreateSession.disabled = false;
    $btnCreateSession.innerHTML = 'Create Session';
    populateCwdSuggestions();
    // Prevent background scroll
    document.body.style.overflow = 'hidden';
    // Focus CWD input after animation
    setTimeout(function () { $newCwd.focus(); }, 350);
  }

  function closeNewSessionModal() {
    $newSessionModal.classList.remove('visible');
    $cwdSuggestions.classList.add('hidden');
    document.body.style.overflow = '';
    // Wait for slide-out animation then hide
    setTimeout(function () {
      $newSessionModal.classList.add('hidden');
    }, 300);
  }

  function updateAgentTypeSelection() {
    var btns = $newAgentType.querySelectorAll('.agent-type-btn');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-type') === selectedAgentType) {
        btns[i].classList.add('selected');
      } else {
        btns[i].classList.remove('selected');
      }
    }
    populateNewModelSelect();
  }

  // Rebuild the new-session model <select> whenever the selected agent
  // changes. Adds a "Custom..." entry at the end when the agent allows
  // arbitrary model names (which is currently every agent).
  function populateNewModelSelect() {
    if (!$newModelSelect) return;
    var spec = AGENT_MODELS[selectedAgentType] || AGENT_MODELS.claude;
    $newModelSelect.replaceChildren();
    spec.presets.forEach(function (preset) {
      var opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = preset.label;
      $newModelSelect.appendChild(opt);
    });
    if (spec.customAllowed) {
      var custom = document.createElement('option');
      custom.value = '__custom__';
      custom.textContent = 'Custom…';
      $newModelSelect.appendChild(custom);
    }
    // Reset selection + hide the custom text field when re-populating.
    $newModelSelect.value = '';
    if ($newModel) {
      $newModel.value = '';
      $newModel.classList.add('hidden');
    }
  }

  if ($newModelSelect) {
    $newModelSelect.addEventListener('change', function () {
      if (!$newModel) return;
      if ($newModelSelect.value === '__custom__') {
        $newModel.classList.remove('hidden');
        $newModel.focus();
      } else {
        $newModel.classList.add('hidden');
        $newModel.value = '';
      }
    });
  }

  // Resolve the operator's model choice when creating a new session:
  // "__custom__" means the value lives in the custom text input.
  function resolveNewSessionModel() {
    if (!$newModelSelect) return '';
    var v = $newModelSelect.value;
    if (v === '__custom__') return ($newModel && $newModel.value.trim()) || '';
    return v || '';
  }

  $newAgentType.addEventListener('click', function (e) {
    var btn = e.target.closest('.agent-type-btn');
    if (!btn) return;
    selectedAgentType = btn.getAttribute('data-type');
    updateAgentTypeSelection();
  });

  $btnNewSession.addEventListener('click', openNewSessionModal);

  $btnCloseModal.addEventListener('click', closeNewSessionModal);

  $newSessionModal.addEventListener('click', function (e) {
    if (e.target === $newSessionModal) closeNewSessionModal();
  });

  // Keyboard: Escape to close, Enter to submit
  document.addEventListener('keydown', function (e) {
    if (!$newSessionModal.classList.contains('visible')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeNewSessionModal();
    }
    if (e.key === 'Enter' && !$btnCreateSession.disabled) {
      // Don't submit if focused on suggestions
      if (document.activeElement && document.activeElement.closest('.cwd-suggestions')) return;
      e.preventDefault();
      $btnCreateSession.click();
    }
  });

  // CWD autocomplete from past sessions
  var cwdMap = {};
  function populateCwdSuggestions() {
    cwdMap = {};
    pastSessions.forEach(function (s) {
      if (s.cwd && !cwdMap[s.cwd]) {
        cwdMap[s.cwd] = s.project || s.cwd.split('/').pop() || s.cwd;
      }
    });
  }

  function filterCwdSuggestions() {
    var cwds = Object.keys(cwdMap);
    if (cwds.length === 0) { $cwdSuggestions.classList.add('hidden'); return; }
    var val = $newCwd.value.toLowerCase();
    var matches = cwds.filter(function (c) {
      return c.toLowerCase().includes(val);
    }).slice(0, 8);

    if (matches.length === 0) { $cwdSuggestions.classList.add('hidden'); return; }

    $cwdSuggestions.classList.remove('hidden');
    $cwdSuggestions.innerHTML = matches.map(function (c) {
      return '<div class="cwd-suggestion" data-cwd="' + escapeHtml(c) + '">' +
        '<span class="cwd-project-name">' + escapeHtml(cwdMap[c]) + '</span>' +
        '<span class="cwd-path">' + escapeHtml(c) + '</span></div>';
    }).join('');
  }

  $newCwd.addEventListener('input', filterCwdSuggestions);
  $newCwd.addEventListener('focus', filterCwdSuggestions);

  $cwdSuggestions.addEventListener('click', function (e) {
    var item = e.target.closest('.cwd-suggestion');
    if (!item) return;
    var cwd = item.getAttribute('data-cwd');
    $newCwd.value = cwd;
    $cwdSuggestions.classList.add('hidden');
    if (!$newName.value && cwdMap[cwd]) {
      $newName.value = cwdMap[cwd];
    }
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('#new-cwd') && !e.target.closest('#cwd-suggestions')) {
      $cwdSuggestions.classList.add('hidden');
    }
  });

  $btnCreateSession.addEventListener('click', function () {
    var cwd = $newCwd.value.trim();
    $newCwd.classList.remove('error');
    if (!cwd) {
      showNewSessionError('Working directory is required.');
      $newCwd.classList.add('error');
      $newCwd.focus();
      return;
    }
    if (!cwd.startsWith('/')) {
      showNewSessionError('Path must be absolute (start with /).');
      $newCwd.classList.add('error');
      $newCwd.focus();
      return;
    }

    $btnCreateSession.disabled = true;
    $btnCreateSession.innerHTML = '<span class="spinner"></span> Creating\u2026';
    $newSessionError.classList.add('hidden');
    $cwdSuggestions.classList.add('hidden');

    authFetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: selectedAgentType,
        cwd: cwd,
        name: $newName.value.trim() || undefined,
        model: resolveNewSessionModel() || undefined,
      }),
    })
    .then(function (r) {
      if (!r.ok) {
        return r.text().then(function (body) {
          var msg = 'Failed to create session (status ' + r.status + ')';
          try { msg = JSON.parse(body).error || msg; } catch (e) {}
          throw new Error(msg);
        });
      }
      return r.json();
    })
    .then(function (result) {
      closeNewSessionModal();
      // Wait for instance to appear via WebSocket, then open it
      var tryOpen = function (attempts) {
        if (instances.has(result.instanceId)) {
          openDetail(result.instanceId);
        } else if (attempts > 0) {
          setTimeout(function () { tryOpen(attempts - 1); }, 500);
        }
      };
      tryOpen(10);
    })
    .catch(function (err) {
      showNewSessionError(err.message || 'Failed to create session.');
      $btnCreateSession.disabled = false;
      $btnCreateSession.innerHTML = 'Create Session';
    });
  });

  function showNewSessionError(msg) {
    $newSessionError.textContent = msg;
    $newSessionError.classList.remove('hidden');
    // Re-trigger shake animation
    $newSessionError.style.animation = 'none';
    void $newSessionError.offsetHeight;
    $newSessionError.style.animation = '';
  }

  // ---- Skills ----

  function loadSkills() {
    showLoading($installedSkillsList, 'Loading skills...');
    authFetch('/api/skills')
      .then(function (r) { return r.json(); })
      .then(function (skills) {
        installedSkills = skills;
        renderInstalledSkills();
      })
      .catch(function () {});
  }

  function truncateText(str, max) {
    if (!str || str.length <= max) return str || '';
    return str.slice(0, max) + '...';
  }

  function renderInstalledSkills() {
    if (installedSkills.length === 0) {
      $installedSkillsList.innerHTML = '<div class="skills-empty">No skills installed. Search above to find skills.</div>';
      return;
    }
    $installedSkillsList.innerHTML = installedSkills.map(function (skill) {
      var tagsHtml = (skill.tags || []).slice(0, 5).map(function (tag) {
        return '<span class="skill-tag">' + escapeHtml(tag) + '</span>';
      }).join('');
      var extraInfo = skill.ruleFiles
        ? '<span>' + skill.ruleFiles + ' extra file' + (skill.ruleFiles !== 1 ? 's' : '') + '</span>'
        : '';
      return (
        '<div class="instance-card skill-card" data-skill-name="' + escapeHtml(skill.name) + '">' +
          '<div class="card-top">' +
            '<span class="card-name">' + escapeHtml(skill.name) + '</span>' +
            '<button class="btn-skill-remove btn-icon btn-danger" data-skill-name="' + escapeHtml(skill.name) + '" title="Remove">&#10005;</button>' +
          '</div>' +
          (skill.description ? '<div class="card-meta"><span>' + escapeHtml(truncateText(skill.description, 80)) + '</span></div>' : '') +
          (tagsHtml || extraInfo ? '<div class="skill-tags">' + tagsHtml + extraInfo + '</div>' : '') +
        '</div>'
      );
    }).join('');

    var cards = $installedSkillsList.querySelectorAll('.skill-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener('click', onInstalledSkillClick);
    }
    var removeBtns = $installedSkillsList.querySelectorAll('.btn-skill-remove');
    for (var j = 0; j < removeBtns.length; j++) {
      removeBtns[j].addEventListener('click', onSkillRemoveClick);
    }
  }

  function onInstalledSkillClick(e) {
    if (e.target.closest('.btn-skill-remove')) return;
    var name = e.currentTarget.getAttribute('data-skill-name');
    openSkillDetail(name, true);
  }

  function onSkillRemoveClick(e) {
    e.stopPropagation();
    var name = e.currentTarget.getAttribute('data-skill-name');
    if (!confirm('Remove skill "' + name + '"?')) return;
    var card = e.currentTarget.closest('.skill-card');
    if (card) card.style.opacity = '0.4';

    authFetch('/api/skills/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function (r) {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(function () { loadSkills(); })
      .catch(function () {
        if (card) card.style.opacity = '';
        alert('Failed to remove skill.');
      });
  }

  function searchSkills(query) {
    if (!query) {
      skillSearchResults = [];
      $skillsSearchResults.classList.add('hidden');
      return;
    }
    $skillsSearchResults.classList.remove('hidden');
    $skillsSearchResults.innerHTML = '<div class="loading-message">Searching...</div>';

    authFetch('/api/skills/search?q=' + encodeURIComponent(query))
      .then(function (r) { return r.json(); })
      .then(function (results) {
        skillSearchResults = results;
        renderSearchResults();
      })
      .catch(function () {
        $skillsSearchResults.innerHTML = '<div class="skills-empty">Search failed.</div>';
      });
  }

  function renderSearchResults() {
    if (skillSearchResults.length === 0) {
      $skillsSearchResults.innerHTML = '<div class="skills-empty">No results found.</div>';
      return;
    }
    var installedNames = new Set(installedSkills.map(function (s) { return s.name; }));

    $skillsSearchResults.innerHTML = skillSearchResults.map(function (result) {
      var isInstalled = installedNames.has(result.name);
      return (
        '<div class="instance-card skill-search-card" data-package="' + escapeHtml(result.package) + '">' +
          '<div class="card-top">' +
            '<span class="card-name">' + escapeHtml(result.name) + '</span>' +
            '<span class="badge badge-session">' + escapeHtml(result.installs) + '</span>' +
          '</div>' +
          '<div class="card-meta"><span>' + escapeHtml(result.package) + '</span></div>' +
          '<div class="skill-actions">' +
            (isInstalled
              ? '<span class="skill-installed-label">Installed</span>'
              : '<button class="btn btn-skill-install" data-package="' + escapeHtml(result.package) + '">Install</button>'
            ) +
          '</div>' +
        '</div>'
      );
    }).join('');

    var installBtns = $skillsSearchResults.querySelectorAll('.btn-skill-install');
    for (var i = 0; i < installBtns.length; i++) {
      installBtns[i].addEventListener('click', onSkillInstallClick);
    }
  }

  function onSkillInstallClick(e) {
    e.stopPropagation();
    var pkg = e.currentTarget.getAttribute('data-package');
    var btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';

    authFetch('/api/skills/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ package: pkg }),
    })
    .then(function (r) {
      if (!r.ok) throw new Error('Install failed');
      return r.json();
    })
    .then(function () {
      btn.textContent = 'Installed';
      btn.classList.add('btn-skill-installed');
      loadSkills();
    })
    .catch(function () {
      btn.textContent = 'Failed';
      btn.disabled = false;
      setTimeout(function () { btn.textContent = 'Install'; }, 2000);
    });
  }

  function openSkillDetail(name, isInstalled) {
    currentSkillDetail = { name: name, installed: isInstalled };
    $skillDetailName.textContent = name;
    $skillDetailContent.innerHTML = '<div class="skills-loading">Loading...</div>';

    if (isInstalled) {
      $btnSkillAction.textContent = 'Remove Skill';
      $btnSkillAction.className = 'btn btn-reject btn-create-session';
    } else {
      $btnSkillAction.textContent = 'Install Skill';
      $btnSkillAction.className = 'btn btn-approve btn-create-session';
    }
    $btnSkillAction.disabled = false;

    $skillDetailModal.classList.remove('hidden');
    void $skillDetailModal.offsetHeight;
    $skillDetailModal.classList.add('visible');
    document.body.style.overflow = 'hidden';

    if (isInstalled) {
      authFetch('/api/skills/' + encodeURIComponent(name) + '/content')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var content = data.content || '';
          content = content.replace(/^---[\s\S]*?---\s*\n/, '');
          $skillDetailContent.innerHTML = renderPlanMarkdown(content);
        })
        .catch(function () {
          $skillDetailContent.innerHTML = '<div class="skills-empty">Failed to load content.</div>';
        });
    } else {
      $skillDetailContent.innerHTML = '<div class="skills-empty">Install this skill to see its full content.</div>';
    }
  }

  function closeSkillDetail() {
    $skillDetailModal.classList.remove('visible');
    // Only restore scroll if skills manager isn't open behind it
    if ($skillsManagerModal.classList.contains('hidden')) {
      document.body.style.overflow = '';
    }
    setTimeout(function () {
      $skillDetailModal.classList.add('hidden');
    }, 300);
    currentSkillDetail = null;
  }

  // Skills Manager modal open/close
  // ---- Git Changes Panel ----

  function openChanges() {
    if (!activeInstanceId) return;
    $changesFileList.innerHTML = '<div class="loading-message">Loading changes...</div>';
    $changesModal.classList.remove('hidden');
    void $changesModal.offsetHeight;
    $changesModal.classList.add('visible');
    document.body.style.overflow = 'hidden';

    authFetch('/api/instances/' + encodeURIComponent(activeInstanceId) + '/changes')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error && !data.repos) {
          $changesFileList.innerHTML = '<div class="changes-empty">' + escapeHtml(data.error) + '</div>';
          return;
        }
        var repos = data.repos || [];
        // Filter to repos that have changes
        var withChanges = repos.filter(function (r) { return r.files.length > 0; });
        if (withChanges.length === 0) {
          $changesFileList.innerHTML = '<div class="changes-empty">Working tree clean</div>';
          return;
        }
        renderChangesRepos(withChanges);
      })
      .catch(function () {
        $changesFileList.innerHTML = '<div class="changes-empty">Failed to load changes</div>';
      });
  }

  function closeChanges() {
    $changesModal.classList.remove('visible');
    document.body.style.overflow = '';
    setTimeout(function () {
      $changesModal.classList.add('hidden');
      $changesFileList.innerHTML = '';
    }, 300);
  }

  function renderChangesRepos(repos) {
    var html = '';
    var globalIdx = 0;
    var statusLabels = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', '??': 'Untracked', AM: 'Added' };

    for (var r = 0; r < repos.length; r++) {
      var repo = repos[r];
      // Show repo name as last path segment
      var repoName = repo.root.split('/').filter(Boolean).pop() || repo.root;

      // Parse diff into per-file sections
      var fileDiffs = {};
      if (repo.diff) {
        var sections = repo.diff.split(/^diff --git /m);
        for (var s = 1; s < sections.length; s++) {
          var section = sections[s];
          var bMatch = section.match(/b\/(.+?)[\n\r]/);
          if (bMatch) {
            fileDiffs[bMatch[1]] = 'diff --git ' + section;
          }
        }
      }

      // Repo header (show if multiple repos)
      if (repos.length > 1) {
        html += '<div class="changes-repo-header">' + escapeHtml(repoName) +
          '<span class="changes-repo-count">' + repo.files.length + ' file' + (repo.files.length !== 1 ? 's' : '') + '</span></div>';
      }

      for (var i = 0; i < repo.files.length; i++) {
        var f = repo.files[i];
        var st = f.status.replace(/\s/g, '') || '?';
        var statusClass = 'status-' + (st === '??' ? 'U' : st.charAt(0));
        var label = st === '??' ? '?' : st;
        var dir = '';
        var name = f.path;
        var slashIdx = f.path.lastIndexOf('/');
        if (slashIdx !== -1) {
          dir = f.path.substring(0, slashIdx + 1);
          name = f.path.substring(slashIdx + 1);
        }

        html += '<div class="changes-file-item" data-idx="' + globalIdx + '" data-path="' + escapeHtml(f.path) + '" title="' + escapeHtml(statusLabels[st] || st) + ': ' + escapeHtml(f.path) + '">';
        html += '<span class="changes-file-status ' + statusClass + '">' + escapeHtml(label) + '</span>';
        html += '<span class="changes-file-path"><span class="changes-file-dir">' + escapeHtml(dir) + '</span>' + escapeHtml(name) + '</span>';
        html += '</div>';

        var diffContent = fileDiffs[f.path] || '';
        html += '<div class="changes-diff-block hidden" id="changes-diff-' + globalIdx + '">';
        if (diffContent) {
          html += '<pre>' + renderDiffLines(diffContent) + '</pre>';
        } else if (st === '??') {
          html += '<pre class="diff-line-add">(untracked file)</pre>';
        } else {
          html += '<pre>(no diff available)</pre>';
        }
        html += '</div>';
        globalIdx++;
      }
    }

    $changesFileList.innerHTML = html;

    // Click to expand/collapse diffs
    $changesFileList.addEventListener('click', function (e) {
      var item = e.target.closest('.changes-file-item');
      if (!item) return;
      var idx = item.dataset.idx;
      var diffBlock = document.getElementById('changes-diff-' + idx);
      if (!diffBlock) return;
      var isExpanded = !diffBlock.classList.contains('hidden');
      if (isExpanded) {
        diffBlock.classList.add('hidden');
        item.classList.remove('expanded');
      } else {
        diffBlock.classList.remove('hidden');
        item.classList.add('expanded');
      }
    });
  }

  function renderDiffLines(diffText) {
    var lines = diffText.split('\n');
    var html = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var escaped = escapeHtml(line);
      if (line.charAt(0) === '+' && line.charAt(1) !== '+') {
        html += '<span class="diff-line-add">' + escaped + '</span>\n';
      } else if (line.charAt(0) === '-' && line.charAt(1) !== '-') {
        html += '<span class="diff-line-del">' + escaped + '</span>\n';
      } else if (line.substring(0, 2) === '@@') {
        html += '<span class="diff-line-hunk">' + escaped + '</span>\n';
      } else {
        html += escaped + '\n';
      }
    }
    return html;
  }

  $btnChanges.addEventListener('click', openChanges);
  $btnCloseChanges.addEventListener('click', closeChanges);
  $changesModal.addEventListener('click', function (e) {
    if (e.target === $changesModal) closeChanges();
  });

  // ---- Skills Manager ----

  function openSkillsManager() {
    loadSkills();
    $skillsManagerModal.classList.remove('hidden');
    void $skillsManagerModal.offsetHeight;
    $skillsManagerModal.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function closeSkillsManager() {
    $skillsManagerModal.classList.remove('visible');
    document.body.style.overflow = '';
    setTimeout(function () {
      $skillsManagerModal.classList.add('hidden');
      // Clear search state on close
      $skillsSearchInput.value = '';
      skillSearchResults = [];
      $skillsSearchResults.classList.add('hidden');
    }, 300);
  }

  $btnSkills.addEventListener('click', openSkillsManager);
  $btnCloseSkillsManager.addEventListener('click', closeSkillsManager);
  $skillsManagerModal.addEventListener('click', function (e) {
    if (e.target === $skillsManagerModal) closeSkillsManager();
  });

  // Skills event listeners
  $skillsSearchInput.addEventListener('input', function () {
    clearTimeout(skillSearchTimeout);
    var query = this.value.trim();
    skillSearchTimeout = setTimeout(function () {
      searchSkills(query);
    }, 500);
  });

  $btnCloseSkillDetail.addEventListener('click', closeSkillDetail);

  $skillDetailModal.addEventListener('click', function (e) {
    if (e.target === $skillDetailModal) closeSkillDetail();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      // Close skill detail first (it sits on top), then skills manager
      if (!$skillDetailModal.classList.contains('hidden')) {
        closeSkillDetail();
      } else if (!$skillsManagerModal.classList.contains('hidden')) {
        closeSkillsManager();
      }
    }
  });

  $btnSkillAction.addEventListener('click', function () {
    if (!currentSkillDetail) return;
    if (currentSkillDetail.installed) {
      if (!confirm('Remove "' + currentSkillDetail.name + '"?')) return;
      $btnSkillAction.disabled = true;
      $btnSkillAction.innerHTML = '<span class="spinner"></span> Removing...';
      authFetch('/api/skills/' + encodeURIComponent(currentSkillDetail.name), { method: 'DELETE' })
        .then(function (r) {
          if (!r.ok) throw new Error();
          return r.json();
        })
        .then(function () {
          closeSkillDetail();
          loadSkills();
        })
        .catch(function () {
          $btnSkillAction.disabled = false;
          $btnSkillAction.textContent = 'Remove Failed';
        });
    } else {
      $btnSkillAction.disabled = true;
      $btnSkillAction.innerHTML = '<span class="spinner"></span> Installing...';
      authFetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: currentSkillDetail.name }),
      })
      .then(function (r) {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(function () {
        closeSkillDetail();
        loadSkills();
      })
      .catch(function () {
        $btnSkillAction.disabled = false;
        $btnSkillAction.textContent = 'Install Failed';
      });
    }
  });

  // ---- Conversation Search ----
  var $btnSearch = document.getElementById('btn-search');

  function triggerSearch() {
    var q = $searchInput.value.trim();
    if (q) searchConversations(q);
  }

  $searchInput.addEventListener('input', function () {
    var q = $searchInput.value.trim();
    if (q) {
      $btnSearch.classList.remove('hidden');
    } else {
      $btnSearch.classList.add('hidden');
      $viewList.classList.remove('searching');
      $searchResults.classList.add('hidden');
      $searchResults.innerHTML = '';
    }
  });

  $btnSearch.addEventListener('click', triggerSearch);

  $searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      triggerSearch();
    } else if (e.key === 'Escape') {
      $searchInput.value = '';
      // Trigger the same teardown the input handler does for empty input
      $searchInput.dispatchEvent(new Event('input'));
      $searchInput.blur();
    }
  });

  function searchConversations(query) {
    $viewList.classList.add('searching');
    $searchResults.classList.remove('hidden');
    $searchResults.innerHTML = '<div class="loading-message">Searching...</div>';

    authFetch('/api/search?q=' + encodeURIComponent(query) + '&limit=20')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.results || data.results.length === 0) {
          $searchResults.innerHTML = '<div class="search-empty">No results found.</div>';
          return;
        }
        $searchResults.innerHTML = data.results.map(function (r) {
          // Escape each segment individually so highlight indices (computed
          // against the raw snippet on the server) stay aligned.
          var snippet;
          if (r.matchIndex >= 0 && r.matchLength > 0) {
            var raw = r.snippet;
            var before = escapeHtml(raw.slice(0, r.matchIndex));
            var match = escapeHtml(raw.slice(r.matchIndex, r.matchIndex + r.matchLength));
            var after = escapeHtml(raw.slice(r.matchIndex + r.matchLength));
            snippet = before + '<mark>' + match + '</mark>' + after;
          } else {
            snippet = escapeHtml(r.snippet);
          }
          var role = r.role === 'user' ? 'User' : r.role === 'assistant' ? 'Assistant' : r.role;
          var time = r.timestamp ? new Date(r.timestamp).toLocaleDateString() : '';
          return (
            '<div class="search-result-item" data-session-id="' + escapeHtml(r.sessionId) + '">' +
              '<div class="search-result-meta">' + escapeHtml(role) + (time ? ' &middot; ' + time : '') + ' &middot; ' + escapeHtml(r.sessionId.slice(0, 8)) + '</div>' +
              '<div class="search-result-snippet">' + snippet + '</div>' +
            '</div>'
          );
        }).join('');

        // Attach click handlers to search results
        var items = $searchResults.querySelectorAll('.search-result-item');
        for (var i = 0; i < items.length; i++) {
          items[i].addEventListener('click', onSearchResultClick);
        }
      })
      .catch(function () {
        $searchResults.innerHTML = '<div class="search-empty">Search failed.</div>';
      });
  }

  function onSearchResultClick(e) {
    var sessionId = e.currentTarget.getAttribute('data-session-id');
    if (!sessionId) return;
    // Stash the active search query so once the destination conversation
    // is loaded we can auto-open the in-conversation search and jump to it.
    var q = $searchInput.value.trim();
    if (q) pendingConvSearchQuery = q;
    // Restore the normal sidebar layout when navigating to a result
    $viewList.classList.remove('searching');

    // 1. Check if there's an active instance with this sessionId
    var found = null;
    instances.forEach(function (inst, id) {
      if (inst.sessionId === sessionId) found = id;
    });
    if (found) {
      openDetail(found);
      return;
    }

    // 2. Look up in past sessions for cwd/project/agentType
    var session = null;
    for (var i = 0; i < pastSessions.length; i++) {
      if (pastSessions[i].sessionId === sessionId) {
        session = pastSessions[i];
        break;
      }
    }
    if (session) {
      resumeSession(sessionId, session.cwd, session.project, session.agentType || 'claude');
      return;
    }

    // 3. Fetch session metadata from API and resume
    authFetch('/api/sessions/' + sessionId + '/history')
      .then(function (r) { return r.json(); })
      .then(function (history) {
        // Extract cwd from history if possible
        var cwd = '';
        var project = sessionId.slice(0, 8);
        if (history.length > 0 && history[0].cwd) {
          cwd = history[0].cwd;
          project = cwd.split('/').pop() || project;
        }
        resumeSession(sessionId, cwd, project, 'claude');
      })
      .catch(function () {});
  }

  // ---- In-Conversation Search ----
  //
  // Client-side text search inside the currently-open conversation. Walks
  // text nodes under #conversation, wraps matches in <mark class="conv-match">,
  // and lets the user step through matches with up/down (or Enter/Shift+Enter).
  // No server round-trip — the conversation is already in the DOM.
  //
  // The search is intentionally non-live with respect to newly-arrived
  // messages: highlights are computed at search time. Clearing the search
  // strips every wrapper this module added, leaving the DOM unchanged.
  var $btnConvSearch = document.getElementById('btn-conv-search');
  var $convSearchBar = document.getElementById('conv-search-bar');
  var $convSearchInput = document.getElementById('conv-search-input');
  var $convSearchCount = document.getElementById('conv-search-count');
  var $btnConvSearchPrev = document.getElementById('btn-conv-search-prev');
  var $btnConvSearchNext = document.getElementById('btn-conv-search-next');
  var $btnConvSearchClose = document.getElementById('btn-conv-search-close');

  var convMatches = [];   // ordered list of <mark.conv-match> elements
  var convMatchIdx = -1;  // index of the currently-focused match
  // When a click on the GLOBAL search results triggers navigation into a
  // session, we stash the user's query here. As soon as the conversation
  // finishes rendering (renderConversation), the in-conversation search is
  // auto-opened with this query so the user lands directly on the match
  // they clicked instead of at the bottom of the conversation.
  var pendingConvSearchQuery = null;

  function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function clearConvMatches() {
    // Replace every <mark.conv-match> with its text content. We collect
    // first because the live NodeList shrinks as we mutate.
    var marks = $conversation.querySelectorAll('mark.conv-match');
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      var parent = m.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize(); // coalesce adjacent text nodes so the next search sees clean text
    }
    convMatches = [];
    convMatchIdx = -1;
    $convSearchCount.textContent = '';
    $convSearchCount.classList.remove('no-matches');
  }

  function highlightConvMatches(query) {
    clearConvMatches();
    if (!query || query.length < 2) return;

    var pattern = new RegExp(escapeRegex(query), 'gi');
    var found = [];

    // Walk text nodes under #conversation. Skip text inside elements we
    // shouldn't modify: existing <mark> (avoid double-wrap), scripts/styles,
    // input/textarea (user prompt isn't visible content anyway).
    var walker = document.createTreeWalker($conversation, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = node.parentNode;
        while (p && p !== $conversation) {
          var tag = p.nodeName;
          if (tag === 'MARK' || tag === 'SCRIPT' || tag === 'STYLE' ||
              tag === 'INPUT' || tag === 'TEXTAREA') {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    // Collect target nodes first because we'll mutate as we go
    var targets = [];
    var n;
    while ((n = walker.nextNode())) targets.push(n);

    for (var i = 0; i < targets.length; i++) {
      var node = targets[i];
      var text = node.nodeValue;
      // matchAll yields all non-overlapping matches with index info; using
      // it avoids the imperative regex iterator pattern.
      var hits = Array.from(text.matchAll(pattern));
      if (hits.length === 0) continue;
      var frag = document.createDocumentFragment();
      var lastEnd = 0;
      for (var hi = 0; hi < hits.length; hi++) {
        var hit = hits[hi];
        if (hit.index > lastEnd) {
          frag.appendChild(document.createTextNode(text.slice(lastEnd, hit.index)));
        }
        var mark = document.createElement('mark');
        mark.className = 'conv-match';
        mark.textContent = hit[0];
        frag.appendChild(mark);
        found.push(mark);
        lastEnd = hit.index + hit[0].length;
      }
      if (lastEnd < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastEnd)));
      }
      node.parentNode.replaceChild(frag, node);
    }

    convMatches = found;
    if (found.length === 0) {
      $convSearchCount.textContent = 'no matches';
      $convSearchCount.classList.add('no-matches');
      convMatchIdx = -1;
    } else {
      focusConvMatch(0);
    }
  }

  function focusConvMatch(idx) {
    if (!convMatches.length) return;
    if (idx < 0) idx = convMatches.length - 1;
    if (idx >= convMatches.length) idx = 0;
    if (convMatchIdx >= 0 && convMatches[convMatchIdx]) {
      convMatches[convMatchIdx].classList.remove('current');
    }
    convMatchIdx = idx;
    var el = convMatches[idx];
    el.classList.add('current');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    $convSearchCount.textContent = (idx + 1) + ' / ' + convMatches.length;
    $convSearchCount.classList.remove('no-matches');
    // Native text selection so the user can immediately copy the match
    // and so the cursor/caret position visibly reflects where they are.
    selectCurrentConvMatch();
  }

  function openConvSearch() {
    $convSearchBar.classList.remove('hidden');
    $convSearchInput.focus();
    $convSearchInput.select();
  }

  // Called from renderConversation() after the conversation DOM is in place.
  // If a global-search click set pendingConvSearchQuery, open the in-conversation
  // search bar pre-populated with that query, highlight, and select the first
  // match (visually + via the native Selection API so the user can copy it).
  function applyPendingConvSearch() {
    if (!pendingConvSearchQuery) return;
    var q = pendingConvSearchQuery;
    pendingConvSearchQuery = null;
    if (!$convSearchBar || !$convSearchInput) return;
    // Defer one frame so any post-render scroll has settled before we
    // scrollIntoView the match.
    requestAnimationFrame(function () {
      $convSearchBar.classList.remove('hidden');
      $convSearchInput.value = q;
      highlightConvMatches(q);
      selectCurrentConvMatch();
    });
  }

  // Use the native Selection API to actually highlight the currently-focused
  // match's text. This lets the user immediately copy it (Ctrl+C) and makes
  // the position unambiguous even if the amber background isn't enough.
  function selectCurrentConvMatch() {
    if (convMatchIdx < 0 || !convMatches[convMatchIdx]) return;
    var el = convMatches[convMatchIdx];
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || typeof sel.removeAllRanges !== 'function') return;
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      // Selection isn't critical; the amber highlight is enough on its own
    }
  }

  function closeConvSearch() {
    clearConvMatches();
    $convSearchInput.value = '';
    $convSearchBar.classList.add('hidden');
  }

  if ($btnConvSearch) {
    $btnConvSearch.addEventListener('click', function () {
      if ($convSearchBar.classList.contains('hidden')) openConvSearch();
      else closeConvSearch();
    });
  }
  if ($btnConvSearchClose) {
    $btnConvSearchClose.addEventListener('click', closeConvSearch);
  }
  if ($btnConvSearchNext) {
    $btnConvSearchNext.addEventListener('click', function () { focusConvMatch(convMatchIdx + 1); });
  }
  if ($btnConvSearchPrev) {
    $btnConvSearchPrev.addEventListener('click', function () { focusConvMatch(convMatchIdx - 1); });
  }

  if ($convSearchInput) {
    var convSearchDebounce;
    $convSearchInput.addEventListener('input', function () {
      clearTimeout(convSearchDebounce);
      var q = $convSearchInput.value.trim();
      // Debounce so each keystroke doesn't trigger a full tree walk
      convSearchDebounce = setTimeout(function () { highlightConvMatches(q); }, 120);
    });
    $convSearchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) focusConvMatch(convMatchIdx - 1);
        else focusConvMatch(convMatchIdx + 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeConvSearch();
      }
    });
  }

  // Ctrl+F / Cmd+F when a detail view is open opens the in-conversation
  // search instead of the browser's find-in-page. Only intercept when a
  // session is actually open; otherwise let the browser handle it.
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      if (activeInstanceId && $viewDetail && !$viewDetail.classList.contains('hidden')) {
        e.preventDefault();
        openConvSearch();
      }
    }
  });

  // ---- Cost Dashboard ----
  function formatCost(n) {
    if (n >= 1) return '$' + n.toFixed(2);
    if (n >= 0.01) return '$' + n.toFixed(3);
    return '$' + n.toFixed(4);
  }

  // ---- Builder Profile (Paxel-style sidebar card) ----
  //
  // Calls GET /api/profile and renders a small radar chart of the five
  // dimension scores, the archetype name + blurb, and a few headline
  // stats. The endpoint is cached server-side (60 s) so it's safe to
  // re-fetch on each dashboard load; we still avoid hammering it on
  // every render cycle by only fetching on initial load and on manual
  // refresh.
  var $profileSection = document.getElementById('profile-section');
  var $profileArchName = document.getElementById('profile-archetype-name');
  var $profileArchBlurb = document.getElementById('profile-archetype-blurb');
  var $profileRadar = document.getElementById('profile-radar');
  var $profileDimensions = document.getElementById('profile-dimensions');
  var $profileStats = document.getElementById('profile-stats');
  var $profileMetaText = document.getElementById('profile-meta-text');
  var $btnRefreshProfile = document.getElementById('btn-refresh-profile');

  var PROFILE_DIMS = ['steering', 'execution', 'engineering', 'productInstinct', 'planning'];
  var PROFILE_DIM_LABELS = {
    steering: 'Steering',
    execution: 'Execution',
    engineering: 'Engineering',
    productInstinct: 'Product',
    planning: 'Planning',
  };

  /**
   * Mobile setup QR codes — only populated when the host runs polpo
   * with `--trust-localhost` AND the dashboard is being accessed from
   * the same machine. The endpoint quietly returns
   * `{available: false, qrs: []}` in any other case, so this fetch is
   * always safe to call (no auth banner flashes, no 401, etc).
   */
  function loadQrCodes() {
    authFetch('/api/qr-codes')
      .then(function (r) {
        if (!r.ok) throw new Error('qr_codes_failed');
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.available || !data.qrs || data.qrs.length === 0) return;
        renderQrCodes(data.qrs);
      })
      .catch(function () {
        // Endpoint may not exist on older hosts; stay silent.
      });
  }

  function renderQrCodes(qrs) {
    var section = document.getElementById('qr-codes-section');
    var list = document.getElementById('qr-codes-list');
    if (!section || !list) return;
    list.replaceChildren();
    qrs.forEach(function (qr) {
      var card = document.createElement('div');
      card.className = 'qr-card qr-card-' + qr.kind;
      var head = document.createElement('div');
      head.className = 'qr-card-label';
      head.textContent = qr.label;
      card.appendChild(head);
      // The server's SVG is trusted because it comes from our own
      // qrcode renderer, fed a server-controlled URI. We still insert
      // it via a sandboxed container — the SVG carries no scripts.
      var svgBox = document.createElement('div');
      svgBox.className = 'qr-card-svg';
      svgBox.innerHTML = qr.svg;
      card.appendChild(svgBox);
      if (qr.hint) {
        var hint = document.createElement('div');
        hint.className = 'qr-card-hint';
        hint.textContent = qr.hint;
        card.appendChild(hint);
      }
      list.appendChild(card);
    });
    section.classList.remove('hidden');
  }

  function loadProfile() {
    authFetch('/api/profile?days=90&agent=all')
      .then(function (r) {
        if (!r.ok) throw new Error('profile_failed');
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.dimensions || !data.archetype) return;
        renderProfile(data);
        $profileSection.classList.remove('hidden');
      })
      .catch(function () {
        // Leave section hidden — the API may be unavailable
        // (e.g. older host) or there may be zero sessions.
      });
  }

  function renderProfile(p) {
    setText($profileArchName, p.archetype.name || '');
    setText($profileArchBlurb, p.archetype.blurb || '');
    renderProfileRadar(p.dimensions);
    renderProfileDimensions(p.dimensions);
    renderProfileStats(p);
    var generated = p.generatedAt ? new Date(p.generatedAt) : null;
    setText($profileMetaText,
      (p.activity && p.activity.totalSessions
        ? p.activity.totalSessions + ' sessions / ' + p.activity.spanDays + ' days'
        : 'no data') +
      (generated ? ' · ' + generated.toLocaleString() : '')
    );
  }

  // Lightweight DOM helper: assigning text via textContent avoids any
  // HTML injection on archetype text the analyzer produces.
  function setText(el, value) {
    if (!el) return;
    el.textContent = value == null ? '' : String(value);
  }

  // Render a 5-axis radar chart as inline SVG. No external libraries —
  // the math is short and keeps the bundle dependency-free.
  // Safety: every interpolated value is either a number we computed
  // (polygon coordinates) or escapeHtml()'d (axis labels). The
  // PROFILE_DIM_LABELS table is hardcoded above, not server-sourced.
  function renderProfileRadar(dimensions) {
    if (!$profileRadar) return;
    var cx = 100, cy = 100, R = 80;
    var n = PROFILE_DIMS.length;
    var parts = [];

    // Grid: 4 concentric polygons at 25/50/75/100 of R
    for (var g = 1; g <= 4; g++) {
      var gr = (R * g) / 4;
      parts.push('<polygon class="grid-poly" points="' + polygonPoints(cx, cy, gr, n) + '"/>');
    }
    // Axis lines
    for (var i = 0; i < n; i++) {
      var pt = vertex(cx, cy, R, i, n);
      parts.push('<line class="axis-line" x1="' + cx + '" y1="' + cy + '" x2="' + pt.x + '" y2="' + pt.y + '"/>');
    }
    // Score polygon
    var scorePts = PROFILE_DIMS.map(function (k, idx) {
      var v = Math.max(0, Math.min(100, Number(dimensions[k]) || 0));
      var r = (R * v) / 100;
      var p = vertex(cx, cy, r, idx, n);
      return p.x + ',' + p.y;
    }).join(' ');
    parts.push('<polygon class="score-poly" points="' + scorePts + '"/>');
    // Axis labels (just outside the outer ring). We override text-anchor
    // per-label so labels on the right of the radar are left-aligned
    // (anchor="start") and labels on the left are right-aligned ("end")
    // — otherwise the longest names overflow the viewBox.
    PROFILE_DIMS.forEach(function (k, idx) {
      var labelR = R + 10;
      var p = vertex(cx, cy, labelR, idx, n);
      // Vertical nudge so top label sits above its axis tip and bottom
      // labels sit below it.
      var dy = p.y < cy - 30 ? -4 : (p.y > cy + 30 ? 12 : 4);
      // Horizontal anchor: middle near the vertical axis, start/end on
      // the sides. 8px deadband keeps near-center labels centered.
      var anchor = 'middle';
      if (p.x < cx - 8) anchor = 'end';
      else if (p.x > cx + 8) anchor = 'start';
      parts.push('<text class="axis-label" x="' + p.x + '" y="' + (p.y + dy) +
        '" text-anchor="' + anchor + '">' + escapeHtml(PROFILE_DIM_LABELS[k] || k) + '</text>');
    });
    $profileRadar.innerHTML = parts.join('');
  }

  function vertex(cx, cy, r, idx, n) {
    // Start at top (-π/2), go clockwise
    var angle = -Math.PI / 2 + (2 * Math.PI * idx) / n;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  }

  function polygonPoints(cx, cy, r, n) {
    var pts = [];
    for (var i = 0; i < n; i++) {
      var p = vertex(cx, cy, r, i, n);
      pts.push(p.x + ',' + p.y);
    }
    return pts.join(' ');
  }

  // Both renderers build trivial structure (two children per cell), so
  // constructing real DOM nodes via createElement + textContent is clearer
  // AND removes any string-concatenation risk on labels that originate
  // from the server (archetype names, dimension values).
  function renderProfileDimensions(dimensions) {
    if (!$profileDimensions) return;
    $profileDimensions.replaceChildren();
    PROFILE_DIMS.forEach(function (k) {
      var v = Math.max(0, Math.min(100, Number(dimensions[k]) || 0));
      var wrap = document.createElement('div');
      wrap.className = 'profile-dim';
      var label = document.createElement('span');
      label.className = 'profile-dim-label';
      label.textContent = PROFILE_DIM_LABELS[k] || k;
      var value = document.createElement('span');
      value.className = 'profile-dim-value';
      value.textContent = String(Math.round(v));
      wrap.appendChild(label);
      wrap.appendChild(value);
      $profileDimensions.appendChild(wrap);
    });
  }

  function renderProfileStats(p) {
    if (!$profileStats) return;
    var cells = [
      ['Active days',    String((p.activity && p.activity.activeDays) || 0)],
      ['Sessions / day', String((p.activity && p.activity.sessionsPerActiveDay) || 0)],
      ['Tool calls',     String((p.tools && p.tools.total) || 0)],
      ['Shell runs',     String((p.shell && p.shell.total) || 0)],
      ['Git commits',    String((p.shell && p.shell.gitCommits) || 0)],
      ['Test runs',      String((p.shell && p.shell.testRuns) || 0)],
    ];
    $profileStats.replaceChildren();
    cells.forEach(function (c) {
      var wrap = document.createElement('div');
      wrap.className = 'profile-stat';
      var label = document.createElement('div');
      label.className = 'profile-stat-label';
      label.textContent = c[0];
      var value = document.createElement('div');
      value.className = 'profile-stat-value';
      value.textContent = c[1];
      wrap.appendChild(label);
      wrap.appendChild(value);
      $profileStats.appendChild(wrap);
    });
  }

  if ($btnRefreshProfile) {
    $btnRefreshProfile.addEventListener('click', loadProfile);
  }

  // Builder Profile: "about this profile" modal. In-app rather than a
  // link to docs/profile.md (which is a repo path the dashboard server
  // doesn't serve) so the explainer works offline and stays consistent
  // with every other dashboard surface.
  var $btnProfileAbout = document.getElementById('btn-profile-about');
  var $profileAboutModal = document.getElementById('profile-about-modal');
  var $btnCloseProfileAbout = document.getElementById('btn-close-profile-about');
  if ($btnProfileAbout && $profileAboutModal) {
    $btnProfileAbout.addEventListener('click', function () {
      $profileAboutModal.classList.remove('hidden');
    });
  }
  if ($btnCloseProfileAbout && $profileAboutModal) {
    $btnCloseProfileAbout.addEventListener('click', function () {
      $profileAboutModal.classList.add('hidden');
    });
  }
  if ($profileAboutModal) {
    // Close when the operator taps the backdrop, matching the pattern
    // used by the other modals in the dashboard.
    $profileAboutModal.addEventListener('click', function (e) {
      if (e.target === $profileAboutModal) {
        $profileAboutModal.classList.add('hidden');
      }
    });
  }

  function loadCosts() {
    authFetch('/api/costs')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        $costSection.classList.remove('hidden');
        $costToday.textContent = formatCost(data.today || 0);
        $costWeek.textContent = formatCost(data.thisWeek || 0);
        $costMonth.textContent = formatCost(data.thisMonth || 0);
        $costTotal.textContent = formatCost(data.total || 0);
        renderCostChart(data.byDay || []);
      })
      .catch(function () {
        // hide section if no data or error
      });
  }

  function renderCostChart(byDay) {
    if (!byDay.length) {
      $costChart.innerHTML = '';
      return;
    }
    var maxCost = 0;
    byDay.forEach(function (d) { if (d.cost > maxCost) maxCost = d.cost; });
    if (maxCost === 0) maxCost = 1;

    $costChart.innerHTML = byDay.map(function (d) {
      var pct = Math.max(2, (d.cost / maxCost) * 100);
      return '<div class="cost-bar" style="height:' + pct + '%" title="' + escapeHtml(d.date) + ': ' + escapeHtml(formatCost(d.cost)) + '"></div>';
    }).join('');
  }

  $btnRefreshCosts.addEventListener('click', loadCosts);

  // ---- Notifications ----
  function updateNotificationBell() {
    if (notificationsEnabled) {
      $btnNotifications.classList.add('active');
    } else {
      $btnNotifications.classList.remove('active');
    }
  }

  function updateNotificationBadge() {
    pendingApprovalCount = 0;
    instances.forEach(function (inst) {
      if (inst.pendingApproval) pendingApprovalCount++;
    });
    if (pendingApprovalCount > 0) {
      $notificationBadge.textContent = pendingApprovalCount;
      $notificationBadge.classList.remove('hidden');
      $notificationBadge.classList.remove('pulse');
      void $notificationBadge.offsetWidth;
      $notificationBadge.classList.add('pulse');
    } else {
      $notificationBadge.classList.add('hidden');
    }
  }

  function sendNotification(title, body, tag) {
    if (!notificationsEnabled || !document.hidden) return;
    if (Notification.permission !== 'granted') return;
    try {
      new Notification(title, {
        body: body,
        icon: '/icon-192.png',
        tag: tag || undefined,
        renotify: !!tag,
      });
    } catch (e) {
      // Notification constructor may fail in some contexts
    }
  }

  function subscribeToPush() {
    authFetch('/api/push/vapid-key')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.publicKey) throw new Error('No VAPID key');
        return navigator.serviceWorker.ready.then(function (reg) {
          var rawKey = atob(data.publicKey.replace(/-/g, '+').replace(/_/g, '/'));
          var keyArray = new Uint8Array(rawKey.length);
          for (var i = 0; i < rawKey.length; i++) keyArray[i] = rawKey.charCodeAt(i);
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyArray });
        });
      })
      .then(function (subscription) {
        return authFetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription.toJSON()),
        });
      })
      .then(function () {
        notificationsEnabled = true;
        localStorage.setItem('polpo_notifications', 'true');
        updateNotificationBell();
      })
      .catch(function () {
        // Push not available — fall back to basic notifications
        notificationsEnabled = true;
        localStorage.setItem('polpo_notifications', 'true');
        updateNotificationBell();
      });
  }

  function unsubscribeFromPush() {
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (subscription) {
      if (subscription) {
        var endpoint = subscription.endpoint;
        return subscription.unsubscribe().then(function () {
          return authFetch('/api/push/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: endpoint }),
          });
        });
      }
    }).then(function () {
      notificationsEnabled = false;
      localStorage.setItem('polpo_notifications', 'false');
      updateNotificationBell();
    }).catch(function () {
      notificationsEnabled = false;
      localStorage.setItem('polpo_notifications', 'false');
      updateNotificationBell();
    });
  }

  var lastNotificationTarget = null;

  $btnNotifications.addEventListener('click', function () {
    // If there are pending approvals, cycle through them
    if (pendingApprovalCount > 0) {
      var approvalIds = [];
      instances.forEach(function (inst, id) {
        if (inst.pendingApproval) approvalIds.push(id);
      });
      if (approvalIds.length > 0) {
        var idx = lastNotificationTarget ? approvalIds.indexOf(lastNotificationTarget) : -1;
        var nextIdx = (idx + 1) % approvalIds.length;
        lastNotificationTarget = approvalIds[nextIdx];
        openDetail(lastNotificationTarget);
        return;
      }
    }

    if (!notificationsEnabled) {
      if (!('Notification' in window)) {
        alert('Notifications not supported in this browser.');
        return;
      }
      Notification.requestPermission().then(function (perm) {
        if (perm === 'granted') {
          if ('PushManager' in window && navigator.serviceWorker) {
            subscribeToPush();
          } else {
            notificationsEnabled = true;
            localStorage.setItem('polpo_notifications', 'true');
            updateNotificationBell();
          }
        }
      });
    } else {
      if ('PushManager' in window && navigator.serviceWorker) {
        unsubscribeFromPush();
      } else {
        notificationsEnabled = false;
        localStorage.setItem('polpo_notifications', 'false');
        updateNotificationBell();
      }
    }
  });

  updateNotificationBell();

  // ---- About Modal ----
  var $aboutModal = document.getElementById('about-modal');
  var $btnAbout = document.getElementById('btn-about');
  var $btnCloseAbout = document.getElementById('btn-close-about');

  function openAbout() {
    $aboutModal.classList.remove('hidden');
    void $aboutModal.offsetHeight;
    $aboutModal.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }
  function closeAbout() {
    $aboutModal.classList.remove('visible');
    document.body.style.overflow = '';
    setTimeout(function () { $aboutModal.classList.add('hidden'); }, 300);
  }
  $btnAbout.addEventListener('click', openAbout);
  $btnCloseAbout.addEventListener('click', closeAbout);
  $aboutModal.addEventListener('click', function (e) {
    if (e.target === $aboutModal) closeAbout();
  });

  // ---- Wake Lock (keep screen on) ----
  var wakeLockSentinel = null;
  var wakeLockEnabled = localStorage.getItem('polpo_wakelock') === 'true';

  function acquireWakeLock() {
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(function (sentinel) {
        wakeLockSentinel = sentinel;
        sentinel.addEventListener('release', function () {
          wakeLockSentinel = null;
        });
      }).catch(function () {});
    } else {
      // Fallback for browsers without Wake Lock API: use a tiny hidden video
      // that tricks the browser into thinking media is playing.
      if (!wakeLockFallbackVideo) {
        var v = document.createElement('video');
        v.setAttribute('playsinline', '');
        v.setAttribute('muted', '');
        v.setAttribute('loop', '');
        v.style.cssText = 'position:fixed;top:-1px;left:-1px;width:1px;height:1px;opacity:0.01';
        // Minimal silent MP4 (base64) — triggers media session without audio
        v.src = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAABltZGF0AAAA0wYF//+c3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE1NyByMjk4MCAtIEguMjY0L01QRUctNCBBVkMgY29kZWMAAAAIYXZjQwAAAAhhdmNDAAAACmNvbmZpZwAAAAhhdmNDAAAADGNvbGxlY3Rpb24=';
        document.body.appendChild(v);
        wakeLockFallbackVideo = v;
      }
      try { wakeLockFallbackVideo.play().catch(function () {}); } catch (e) {}
    }
  }

  function releaseWakeLock() {
    if (wakeLockSentinel) {
      wakeLockSentinel.release().catch(function () {});
      wakeLockSentinel = null;
    }
    if (wakeLockFallbackVideo) {
      wakeLockFallbackVideo.pause();
    }
  }

  var wakeLockFallbackVideo = null;

  function updateWakeLockButton() {
    if (wakeLockEnabled) {
      $btnWakeLock.classList.add('active');
      $btnWakeLock.title = 'Screen stays awake (tap to disable)';
    } else {
      $btnWakeLock.classList.remove('active');
      $btnWakeLock.title = 'Keep screen awake';
    }
  }

  $btnWakeLock.addEventListener('click', function () {
    wakeLockEnabled = !wakeLockEnabled;
    localStorage.setItem('polpo_wakelock', wakeLockEnabled ? 'true' : 'false');
    if (wakeLockEnabled) {
      acquireWakeLock();
    } else {
      releaseWakeLock();
    }
    updateWakeLockButton();
  });

  // Re-acquire wake lock when returning to foreground (OS releases it on background)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && wakeLockEnabled) {
      acquireWakeLock();
    }
  });

  updateWakeLockButton();
  if (wakeLockEnabled) acquireWakeLock();

  // ---- Reconnect on wake / network change ----
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      // Always force-reconnect when returning to foreground.
      // On mobile, the TCP connection is often dead after sleep/background
      // but readyState still shows OPEN (half-open socket).
      forceReconnect();
    }
  });

  window.addEventListener('online', function () {
    // Network restored (e.g. Wi-Fi reconnect, VPN toggle) — reconnect immediately
    forceReconnect();
  });

  // ---- Init ----
  showLoading($instanceList, 'Connecting...');
  connect();
  loadSessions();
  loadCosts();
  loadProfile();
  loadQrCodes();

  // Fetch version from health endpoint
  fetch('/health').then(function (r) { return r.json(); }).then(function (data) {
    if (data.version) {
      var versionText = 'v' + data.version;
      document.getElementById('app-version').textContent = versionText;
      document.getElementById('about-version').textContent = versionText;
    }
  }).catch(function () {});
})();
