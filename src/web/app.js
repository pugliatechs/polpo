/* ==============================
   Polpo — Mobile Web App
   ============================== */

(function () {
  'use strict';

  // ---- State ----
  let ws = null;
  let instances = new Map();
  let activeInstanceId = null;
  let reconnectDelay = 1000;

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
  const $btnReject = document.getElementById('btn-reject');

  // ---- WebSocket ----
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}?role=dashboard`;
    ws = new WebSocket(url);

    ws.onopen = function () {
      $connectionStatus.className = 'status-dot connected';
      $connectionStatus.title = 'Connected';
      reconnectDelay = 1000;
    };

    ws.onclose = function () {
      $connectionStatus.className = 'status-dot disconnected';
      $connectionStatus.title = 'Disconnected';
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    };

    ws.onmessage = function (evt) {
      try {
        var msg = JSON.parse(evt.data);
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
          instances.set(inst.id, inst);
        });
        renderList();
        break;

      case 'instance:registered':
        msg.instance.conversation = [];
        instances.set(msg.instance.id, msg.instance);
        renderList();
        break;

      case 'instance:disconnected':
        if (instances.has(msg.instanceId)) {
          instances.get(msg.instanceId).status = 'disconnected';
        }
        renderList();
        if (activeInstanceId === msg.instanceId) renderDetail();
        break;

      case 'instance:status':
        if (instances.has(msg.id)) {
          instances.get(msg.id).status = msg.status;
        }
        renderList();
        if (activeInstanceId === msg.id) renderDetail();
        break;

      case 'instance:message':
        if (instances.has(msg.id)) {
          var inst = instances.get(msg.id);
          if (!inst.conversation) inst.conversation = [];
          inst.conversation.push(msg.message);
        }
        if (activeInstanceId === msg.id) {
          appendMessage(msg.message);
        }
        break;

      case 'instance:approval':
        if (instances.has(msg.id)) {
          instances.get(msg.id).pendingApproval = msg.approval;
          instances.get(msg.id).status = 'waiting';
        }
        renderList();
        if (activeInstanceId === msg.id) renderDetail();
        break;
    }
  }

  // ---- Render: Instance List ----
  function renderList() {
    var arr = Array.from(instances.values()).filter(function (i) {
      return i.status !== 'disconnected';
    });

    // Also show recently disconnected (last 30s)
    var disconnected = Array.from(instances.values()).filter(function (i) {
      return i.status === 'disconnected';
    });
    arr = arr.concat(disconnected);

    $instanceCount.textContent = arr.length + ' instance' + (arr.length !== 1 ? 's' : '');

    if (arr.length === 0) {
      $emptyState.classList.remove('hidden');
      $instanceList.innerHTML = '';
      return;
    }

    $emptyState.classList.add('hidden');

    $instanceList.innerHTML = arr
      .map(function (inst) {
        var badgeClass = 'badge badge-' + inst.status;
        var cardClass = 'instance-card ' + inst.status;
        var approvalHtml = '';
        if (inst.pendingApproval) {
          approvalHtml =
            '<div class="card-approval">⚠ ' +
            escapeHtml(inst.pendingApproval.description || 'Action requires approval') +
            '</div>';
        }
        return (
          '<div class="' + cardClass + '" data-id="' + inst.id + '">' +
            '<div class="card-top">' +
              '<span class="card-name">' + escapeHtml(inst.name) + '</span>' +
              '<span class="' + badgeClass + '">' + inst.status + '</span>' +
            '</div>' +
            '<div class="card-meta">' +
              '<span>📁 ' + escapeHtml(inst.project || '') + '</span>' +
              '<span>' + (inst.type === 'vscode' ? '💻 VS Code' : '⬛ Terminal') + '</span>' +
            '</div>' +
            approvalHtml +
          '</div>'
        );
      })
      .join('');

    // Attach click handlers
    var cards = $instanceList.querySelectorAll('.instance-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener('click', onCardClick);
    }
  }

  function onCardClick(e) {
    var card = e.currentTarget;
    var id = card.getAttribute('data-id');
    openDetail(id);
  }

  // ---- Render: Detail View ----
  function openDetail(id) {
    activeInstanceId = id;

    // Fetch conversation if we don't have it yet
    var inst = instances.get(id);
    if (inst && (!inst.conversation || inst.conversation.length === 0)) {
      fetch('/api/instances/' + id + '/conversation?limit=100')
        .then(function (r) { return r.json(); })
        .then(function (msgs) {
          inst.conversation = msgs;
          renderConversation();
        })
        .catch(function () {});
    }

    $viewList.classList.add('hidden');
    $viewDetail.classList.remove('hidden');
    renderDetail();
    renderConversation();
    $promptInput.focus();
  }

  function closeDetail() {
    activeInstanceId = null;
    $viewDetail.classList.add('hidden');
    $viewList.classList.remove('hidden');
    renderList();
  }

  function renderDetail() {
    var inst = instances.get(activeInstanceId);
    if (!inst) return;

    $detailName.textContent = inst.name;
    $detailStatus.textContent = inst.status;
    $detailStatus.className = 'badge badge-' + inst.status;
    $detailProject.textContent = '📁 ' + (inst.project || '');
    $detailType.textContent = inst.type === 'vscode' ? '💻 VS Code' : '⬛ Terminal';

    // Approval banner
    if (inst.pendingApproval) {
      $approvalBanner.classList.remove('hidden');
      $approvalDescription.textContent = inst.pendingApproval.description || '';
      $approvalCommand.textContent = inst.pendingApproval.command || '';
      if (!inst.pendingApproval.command) {
        $approvalCommand.style.display = 'none';
      } else {
        $approvalCommand.style.display = 'block';
      }
    } else {
      $approvalBanner.classList.add('hidden');
    }
  }

  function renderConversation() {
    var inst = instances.get(activeInstanceId);
    if (!inst || !inst.conversation) {
      $conversation.innerHTML = '';
      return;
    }

    $conversation.innerHTML = inst.conversation
      .map(function (m) {
        return formatMessage(m);
      })
      .join('');
    scrollToBottom();
  }

  function appendMessage(msg) {
    $conversation.insertAdjacentHTML('beforeend', formatMessage(msg));
    scrollToBottom();
  }

  function formatMessage(m) {
    var cls = 'msg msg-' + (m.role || 'system');
    if (m.source === 'mobile') cls += ' from-mobile';
    var time = m.timestamp ? formatTime(m.timestamp) : '';
    return (
      '<div class="' + cls + '">' +
        escapeHtml(m.content || '') +
        (time ? '<div class="msg-time">' + time + '</div>' : '') +
      '</div>'
    );
  }

  function scrollToBottom() {
    $conversation.scrollTop = $conversation.scrollHeight;
  }

  // ---- Actions ----
  function sendPrompt() {
    var text = $promptInput.value.trim();
    if (!text || !activeInstanceId) return;

    send({ type: 'send_prompt', instanceId: activeInstanceId, text: text });
    $promptInput.value = '';
    $promptInput.style.height = 'auto';
    $btnSend.disabled = true;
  }

  // ---- Event Listeners ----
  $btnBack.addEventListener('click', closeDetail);

  $btnSend.addEventListener('click', sendPrompt);

  $btnAbort.addEventListener('click', function () {
    if (activeInstanceId && confirm('Abort current task?')) {
      send({ type: 'abort', instanceId: activeInstanceId });
    }
  });

  $btnApprove.addEventListener('click', function () {
    if (activeInstanceId) {
      send({ type: 'approve', instanceId: activeInstanceId });
    }
  });

  $btnReject.addEventListener('click', function () {
    if (activeInstanceId) {
      send({ type: 'reject', instanceId: activeInstanceId });
    }
  });

  $promptInput.addEventListener('input', function () {
    $btnSend.disabled = !$promptInput.value.trim();
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

  // ---- Helpers ----
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function formatTime(ts) {
    var d = new Date(ts);
    var h = d.getHours().toString().padStart(2, '0');
    var m = d.getMinutes().toString().padStart(2, '0');
    return h + ':' + m;
  }

  // ---- Init ----
  connect();
})();
