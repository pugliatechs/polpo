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
  const $autoApproveBanner = document.getElementById('auto-approve-banner');
  const $btnStopAutoApprove = document.getElementById('btn-stop-auto-approve');
  const $sessionsSection = document.getElementById('sessions-section');
  const $sessionsList = document.getElementById('sessions-list');
  const $btnRefreshSessions = document.getElementById('btn-refresh-sessions');
  const $takeoverBanner = document.getElementById('takeover-banner');
  const $btnTakeover = document.getElementById('btn-takeover');
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
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}?role=dashboard`;
    ws = new WebSocket(url);

    ws.onopen = function () {
      $connectionStatus.className = 'status-dot connected';
      $connectionStatus.title = 'Connected';
      reconnectDelay = 1000;
    };

    ws.onclose = function (evt) {
      $connectionStatus.className = 'status-dot disconnected';
      $connectionStatus.title = 'Disconnected';
      if (evt.code === 4001) {
        // Auth required — redirect to auth page
        location.href = '/auth.html';
        return;
      }
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
          if (msg.approval) {
            instances.get(msg.id).status = 'waiting';
          } else {
            instances.get(msg.id).status = 'busy';
          }
        }
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
      // If the instance has a sessionId, load full history from JSONL
      if (inst.sessionId) {
        authFetch('/api/sessions/' + inst.sessionId + '/history')
          .then(function (r) { return r.json(); })
          .then(function (history) {
            if (history.length > 0) {
              inst.conversation = history.concat(inst.conversation || []);
            }
            renderConversation();
          })
          .catch(function () {});
      } else {
        authFetch('/api/instances/' + id + '/conversation?limit=100')
          .then(function (r) { return r.json(); })
          .then(function (msgs) {
            inst.conversation = msgs;
            renderConversation();
          })
          .catch(function () {});
      }
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

    // Takeover vs prompt input
    var canPrompt = inst.canReceivePrompts !== false;
    if (!canPrompt && inst.sessionId) {
      $takeoverBanner.classList.remove('hidden');
      $inputArea.classList.add('hidden');
    } else {
      $takeoverBanner.classList.add('hidden');
      $inputArea.classList.remove('hidden');
    }

    // Auto-approve indicator
    if (inst.autoApprove) {
      $autoApproveBanner.classList.remove('hidden');
    } else {
      $autoApproveBanner.classList.add('hidden');
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
    var contentType = m.contentType || 'text';
    var time = m.timestamp ? formatTime(m.timestamp) : '';
    var timeHtml = time ? '<div class="msg-time">' + time + '</div>' : '';

    // Tool use: show as a compact card
    if (contentType === 'tool_use') {
      try {
        var tool = JSON.parse(m.content);
        var inputSummary = '';
        if (tool.name === 'Bash' || tool.name === 'bash') {
          inputSummary = tool.input && tool.input.command
            ? escapeHtml(tool.input.command)
            : '';
        } else if (tool.name === 'Read') {
          inputSummary = escapeHtml(tool.input && tool.input.file_path || '');
        } else if (tool.name === 'Edit' || tool.name === 'Write') {
          inputSummary = escapeHtml(tool.input && tool.input.file_path || '');
        } else if (tool.name === 'Grep') {
          inputSummary = escapeHtml(tool.input && tool.input.pattern || '');
        } else if (tool.name === 'Glob') {
          inputSummary = escapeHtml(tool.input && tool.input.pattern || '');
        } else {
          inputSummary = escapeHtml(JSON.stringify(tool.input || {}).slice(0, 120));
        }
        return (
          '<div class="msg msg-tool-use">' +
            '<div class="tool-name">' + escapeHtml(tool.name) + '</div>' +
            (inputSummary ? '<div class="tool-input">' + inputSummary + '</div>' : '') +
            timeHtml +
          '</div>'
        );
      } catch (e) {}
    }

    // Tool result: show as compact output
    if (contentType === 'tool_result') {
      var cls = 'msg msg-tool-result' + (m.isError ? ' tool-error' : '');
      var content = m.content || '';
      // Strip XML wrapper tags from tool errors
      content = content.replace(/<\/?tool_use_error>/g, '');
      if (content.length > 500) {
        content = content.slice(0, 500) + '\n...';
      }
      return (
        '<div class="' + cls + '">' +
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

    // JSON system init: skip rendering
    if (contentType === 'json' && m.role === 'system') {
      return '';
    }

    // Default: text message
    var cls = 'msg msg-' + (m.role || 'system');
    if (m.source === 'mobile') cls += ' from-mobile';
    var rendered = m.role === 'assistant'
      ? renderMarkdown(m.content || '')
      : escapeHtml(m.content || '');

    // Attachment indicators for user messages
    var attachHtml = '';
    if (m.attachments && m.attachments.length > 0) {
      attachHtml = '<div class="msg-attachments">' +
        m.attachments.map(function (att) {
          if (att.mediaType && att.mediaType.startsWith('image/')) {
            var thumbUrl = '/api/uploads/' + att.path.split('/').pop();
            return '<img class="msg-attachment-thumb" src="' + thumbUrl + '" alt="' + escapeHtml(att.filename) + '">';
          }
          return '<span class="msg-attachment-file">&#128196; ' + escapeHtml(att.filename) + '</span>';
        }).join('') +
      '</div>';
    }

    return (
      '<div class="' + cls + '">' +
        attachHtml +
        rendered +
        timeHtml +
      '</div>'
    );
  }

  function scrollToBottom() {
    $conversation.scrollTop = $conversation.scrollHeight;
  }

  // ---- Actions ----
  function sendPrompt() {
    var text = $promptInput.value.trim();
    if ((!text && pendingAttachments.length === 0) || !activeInstanceId) return;

    var attachments = pendingAttachments.map(function (a) {
      return { id: a.id, path: a.path, filename: a.filename, mediaType: a.mediaType };
    });

    send({
      type: 'send_prompt',
      instanceId: activeInstanceId,
      text: text || (attachments.length > 0 ? 'See attached file(s).' : ''),
      attachments: attachments,
    });

    clearAttachments();
    $promptInput.value = '';
    $promptInput.style.height = 'auto';
    updateSendButton();
  }

  function updateSendButton() {
    $btnSend.disabled = !$promptInput.value.trim() && pendingAttachments.length === 0;
  }

  function takeover(instanceId) {
    authFetch('/api/instances/' + instanceId + '/takeover', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (result.instanceId) {
          // Switch to the new takeover instance when it appears
          var tryOpen = function (attempts) {
            if (instances.has(result.instanceId)) {
              openDetail(result.instanceId);
            } else if (attempts > 0) {
              setTimeout(function () { tryOpen(attempts - 1); }, 500);
            }
          };
          tryOpen(6);
        }
      })
      .catch(function () {});
  }

  // ---- Event Listeners ----
  $btnBack.addEventListener('click', closeDetail);

  $btnSend.addEventListener('click', sendPrompt);

  $btnTakeover.addEventListener('click', function () {
    if (activeInstanceId) takeover(activeInstanceId);
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
        '<div class="question-item" data-qi="' + qi + '" data-multi="' + (q.multiSelect ? '1' : '0') + '">' +
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
      var qi = items[i].getAttribute('data-qi');
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
      answers[qi] = isMulti ? values : (values[0] || '');
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

    // Code blocks: ```lang\n...\n``` → <pre><code>...</code></pre>
    escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, function (match, lang, code) {
      return '<pre class="code-block"><code>' + code.replace(/\n$/, '') + '</code></pre>';
    });

    // Inline code: `...` → <code>...</code>
    escaped = escaped.replace(/`([^`\n]+)`/g, '<code class="code-inline">$1</code>');

    // Bold: **...** → <strong>...</strong>
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Numbered lists: lines starting with "1. " etc
    escaped = escaped.replace(/^(\d+)\.\s+(.*)$/gm, '<span class="list-item"><span class="list-num">$1.</span> $2</span>');

    // Arrow → (just render nicely)
    escaped = escaped.replace(/→/g, '<span class="arrow">→</span>');

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
    instances.forEach(function (inst) {
      if (inst.sessionId) activeSessionIds.add(inst.sessionId);
    });

    var filtered = pastSessions.filter(function (s) {
      return !activeSessionIds.has(s.sessionId);
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
      return (
        '<div class="instance-card session-card" data-session-id="' + s.sessionId + '" data-cwd="' + escapeHtml(s.cwd) + '" data-project="' + escapeHtml(s.project) + '">' +
          '<div class="card-top">' +
            '<span class="card-name">' + escapeHtml(title) + '</span>' +
            '<span class="badge badge-session">' + ago + '</span>' +
          '</div>' +
          '<div class="card-meta">' +
            '<span>' + escapeHtml(s.project) + '</span>' +
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
    resumeSession(sessionId, cwd, project);
  }

  function resumeSession(sessionId, cwd, project) {
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
      body: JSON.stringify({ name: project, cwd: cwd }),
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
      if (activeInstanceId) scrollToBottom();
    };
    window.visualViewport.addEventListener('resize', onViewportResize);
    window.visualViewport.addEventListener('scroll', onViewportResize);
  }

  // ---- Init ----
  connect();
  loadSessions();
})();
