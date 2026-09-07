/**
 * Harbor Renderer - Full Window Navigation and Local Chat Logic
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
  const btnShowSidebar = document.getElementById('btn-show-sidebar');
  const iconToggleSidebar = document.getElementById('icon-toggle-sidebar');

  const btnNewChat = document.getElementById('btn-new-chat');
  const btnHistory = document.getElementById('btn-history');
  const historyPanel = document.getElementById('history-panel');
  const historyList = document.getElementById('history-list');
  const btnShowArchived = document.getElementById('btn-show-archived');

  const dotAiStatus = document.getElementById('dot-ai-status');
  const lblAiStatus = document.getElementById('lbl-ai-status');
  const selectModel = document.getElementById('select-model');
  const btnPullModel = document.getElementById('btn-pull-model');

  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const btnSend = document.getElementById('btn-send');

  const navBack = document.getElementById('nav-back');
  const navForward = document.getElementById('nav-forward');
  const navReload = document.getElementById('nav-reload');

  const toast = document.getElementById('toast');
  const toastIcon = document.getElementById('toast-icon');
  const toastMessage = document.getElementById('toast-message');

  // State Variables
  const conversationHistory = [];
  let currentConversationId = null;
  let showArchived = false;
  let isOllamaOnline = false;
  let isThinking = false;

  // --- Toast Utilities ---
  function showToast(message, type = 'info') {
    toastMessage.textContent = message;
    toast.className = 'toast-container show';

    if (type === 'error') {
      toastIcon.textContent = '❌';
      toast.classList.add('toast-error');
    } else if (type === 'success') {
      toastIcon.textContent = '✅';
      toast.classList.add('toast-success');
    } else {
      toastIcon.textContent = 'ℹ️';
    }

    setTimeout(() => {
      toast.className = 'toast-container';
    }, 4000);
  }

  // --- Sidebar Collapse/Expand Logic ---
  function setSidebarCollapsedState(isCollapsed) {
    if (isCollapsed) {
      document.body.classList.add('sidebar-collapsed');
      if (iconToggleSidebar) {
        iconToggleSidebar.innerHTML = '<polyline points="9 18 15 12 9 6"></polyline>';
      }
    } else {
      document.body.classList.remove('sidebar-collapsed');
      if (iconToggleSidebar) {
        iconToggleSidebar.innerHTML = '<polyline points="15 18 9 12 15 6"></polyline>';
      }
    }
  }

  // Load saved sidebar state
  try {
    const settings = await window.electronAPI.getSettings();
    if (settings && settings.chatCollapsed) {
      setSidebarCollapsedState(true);
      window.electronAPI.resizeWebview(true);
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }

  if (btnToggleSidebar) {
    btnToggleSidebar.addEventListener('click', async () => {
      const isCollapsed = !document.body.classList.contains('sidebar-collapsed');
      setSidebarCollapsedState(isCollapsed);
      await window.electronAPI.setSettings({ chatCollapsed: isCollapsed });
      await window.electronAPI.resizeWebview(isCollapsed);
    });
  }

  if (btnShowSidebar) {
    btnShowSidebar.addEventListener('click', async () => {
      setSidebarCollapsedState(false);
      await window.electronAPI.setSettings({ chatCollapsed: false });
      await window.electronAPI.resizeWebview(false);
    });
  }

  // --- BrowserView Navigation Event Listeners ---
  navBack.addEventListener('click', () => {
    window.electronAPI.goBack();
  });

  navForward.addEventListener('click', () => {
    window.electronAPI.goForward();
  });

  navReload.addEventListener('click', () => {
    window.electronAPI.reload();
  });

  // Receive navigation updates from BrowserView
  window.electronAPI.onNavUpdate((state) => {
    navBack.disabled = !state.canGoBack;
    navForward.disabled = !state.canGoForward;
  });

  // --- Conversation History & Management ---

  function generateConversationId() {
    return Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  }

  function resetChatUI() {
    conversationHistory.length = 0;
    chatMessages.innerHTML = `
      <div class="message assistant">
        <span class="message-label">Wave AI Co-Pilot</span>
        <div class="message-bubble">
          Hello! I am your Wave OS Local AI Assistant. I run fully offline on your GPU. 
          Select a model above to begin chatting! If you don't have Llama 3 yet, click the <strong>Pull</strong> button to download it.
        </div>
      </div>
    `;
  }

  async function autoSaveConversation() {
    if (conversationHistory.length === 0) return;

    if (!currentConversationId) {
      currentConversationId = generateConversationId();
    }

    const firstUserMsg = conversationHistory.find(m => m.role === 'user');
    let title = 'New Conversation';
    if (firstUserMsg && firstUserMsg.content) {
      title = firstUserMsg.content.trim().substring(0, 40);
    }

    const conv = {
      id: currentConversationId,
      title: title,
      messages: [...conversationHistory],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false
    };

    await window.electronAPI.saveConversation(conv);
  }

  function formatDate(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  async function renderHistoryList() {
    try {
      const conversations = await window.electronAPI.getConversations();
      historyList.innerHTML = '';

      let filtered = conversations.filter(c => showArchived ? true : !c.archived);

      if (!showArchived) {
        filtered = filtered.slice(0, 20);
      }

      if (filtered.length === 0) {
        historyList.innerHTML = '<div style="padding:16px; text-align:center; color:var(--muted); font-size:12px;">No conversations found</div>';
        return;
      }

      filtered.forEach(conv => {
        const itemDiv = document.createElement('div');
        itemDiv.className = `history-item ${conv.archived ? 'archived' : ''} ${conv.id === currentConversationId ? 'active' : ''}`;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'history-item-content';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'history-item-title';
        const rawTitle = conv.title || (conv.messages && conv.messages[0] ? conv.messages[0].content : 'Untitled');
        titleDiv.textContent = rawTitle.length > 40 ? rawTitle.substring(0, 40) + '...' : rawTitle;

        const dateDiv = document.createElement('div');
        dateDiv.className = 'history-item-date';
        dateDiv.textContent = formatDate(conv.updatedAt || conv.createdAt);

        contentDiv.appendChild(titleDiv);
        contentDiv.appendChild(dateDiv);

        const archiveBtn = document.createElement('button');
        archiveBtn.className = 'btn-archive-item';
        archiveBtn.title = conv.archived ? 'Archived' : 'Archive conversation';
        archiveBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="21 8 21 21 3 21 3 8"></polyline>
            <rect x="1" y="3" width="22" height="5"></rect>
            <line x1="10" y1="12" x2="14" y2="12"></line>
          </svg>
        `;

        archiveBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await window.electronAPI.archiveConversation(conv.id);
          await renderHistoryList();
          showToast('Conversation archived', 'info');
        });

        itemDiv.appendChild(contentDiv);
        itemDiv.appendChild(archiveBtn);

        itemDiv.addEventListener('click', () => {
          loadConversation(conv);
          historyPanel.classList.add('hidden');
          btnHistory.classList.remove('active');
        });

        historyList.appendChild(itemDiv);
      });
    } catch (err) {
      console.error('Failed to render history list:', err);
    }
  }

  function loadConversation(conv) {
    currentConversationId = conv.id;
    conversationHistory.length = 0;
    chatMessages.innerHTML = '';

    if (conv.messages && conv.messages.length > 0) {
      conv.messages.forEach(msg => {
        conversationHistory.push({ role: msg.role, content: msg.content });
        appendMessage(msg.role, msg.content);
      });
    } else {
      resetChatUI();
    }
  }

  btnNewChat.addEventListener('click', async () => {
    if (conversationHistory.length > 0) {
      await autoSaveConversation();
    }
    resetChatUI();
    currentConversationId = null;
    if (!historyPanel.classList.contains('hidden')) {
      await renderHistoryList();
    }
    showToast('Started new conversation', 'info');
  });

  btnHistory.addEventListener('click', async () => {
    historyPanel.classList.toggle('hidden');
    btnHistory.classList.toggle('active', !historyPanel.classList.contains('hidden'));
    if (!historyPanel.classList.contains('hidden')) {
      await renderHistoryList();
    }
  });

  btnShowArchived.addEventListener('click', async () => {
    showArchived = !showArchived;
    btnShowArchived.textContent = showArchived ? 'Hide Archived' : 'Show Archived';
    await renderHistoryList();
  });

  // --- Local AI Chat Operations ---

  // Check Ollama tags and populate model dropdown
  async function refreshModels() {
    try {
      const status = await window.electronAPI.checkOllama();
      isOllamaOnline = status.running;

      if (isOllamaOnline) {
        dotAiStatus.className = 'status-dot active';
        lblAiStatus.textContent = 'Ollama Online';
        lblAiStatus.style.color = 'var(--green)';

        const availableModels = status.models || [];
        const previousSelection = selectModel.value;

        if (availableModels.length > 0) {
          selectModel.innerHTML = '';
          availableModels.forEach((modelName) => {
            const opt = document.createElement('option');
            opt.value = modelName;
            opt.textContent = modelName;
            selectModel.appendChild(opt);
          });

          if (availableModels.includes(previousSelection)) {
            selectModel.value = previousSelection;
          } else {
            const savedDefault = localStorage.getItem('wave_default_model');
            if (savedDefault && availableModels.includes(savedDefault)) {
              selectModel.value = savedDefault;
            } else {
              selectModel.selectedIndex = 0;
            }
          }
          
          if (!isThinking) {
            chatInput.disabled = false;
            btnSend.disabled = false;
          }
        } else {
          selectModel.innerHTML = '<option value="">No Models Found (Click Pull)</option>';
          chatInput.disabled = true;
          btnSend.disabled = true;
        }
      } else {
        dotAiStatus.className = 'status-dot inactive';
        lblAiStatus.textContent = 'Ollama Offline';
        lblAiStatus.style.color = 'var(--muted)';
        selectModel.innerHTML = '<option value="">Ollama Stopped</option>';
        chatInput.disabled = true;
        btnSend.disabled = true;
      }
    } catch (err) {
      console.error('Error loading Ollama models:', err);
    }
  }

  // Pull Model Handler
  btnPullModel.addEventListener('click', async () => {
    const modelToPull = prompt('Enter the name of the model you want to pull (e.g. llama3, mistral, phi3, gemma):', 'llama3');
    if (!modelToPull) return;

    const trimmedModelName = modelToPull.trim();
    if (trimmedModelName) {
      showToast(`Started pulling model '${trimmedModelName}' in background...`, 'info');
      btnPullModel.disabled = true;
      btnPullModel.textContent = 'Pulling...';

      try {
        const result = await window.electronAPI.pullModel(trimmedModelName);
        if (result.success) {
          showToast(`Successfully pulled model '${trimmedModelName}'!`, 'success');
          localStorage.setItem('wave_default_model', trimmedModelName);
          await refreshModels();
        }
      } catch (err) {
        showToast(`Failed to pull model: ${err.message || err}`, 'error');
      } finally {
        btnPullModel.disabled = false;
        btnPullModel.textContent = 'Pull';
      }
    }
  });

  // Append message to scrollable window area
  function appendMessage(sender, text, provider) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}`;

    const labelSpan = document.createElement('span');
    labelSpan.className = 'message-label';
    labelSpan.textContent = sender === 'user' ? 'You' : 'Wave AI Co-Pilot';

    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = 'message-bubble';
    
    if (sender === 'user') {
      bubbleDiv.textContent = text;
    } else {
      bubbleDiv.innerHTML = window.sharedUtils.renderMarkdown(text);
    }

    // Provider badge for AI responses
    if (sender === 'assistant' && provider) {
      const badge = document.createElement('span');
      badge.className = 'provider-badge';
      if (provider === 'ollama') {
        badge.textContent = 'gemma3:12b \u2022 Local';
        badge.style.color = '#2ee6c5';
        badge.style.borderColor = 'rgba(46, 230, 197, 0.3)';
      } else if (provider === 'theta') {
        badge.textContent = 'Wave AI \u2022 Theta';
        badge.style.color = '#a855f7';
        badge.style.borderColor = 'rgba(168, 85, 247, 0.3)';
      }
      badge.style.cssText += 'display:inline-block;font-size:10px;padding:2px 8px;border-radius:6px;border:1px solid;margin-top:4px;font-weight:500;background:rgba(255,255,255,0.03);';
      messageDiv.appendChild(labelSpan);
      messageDiv.appendChild(bubbleDiv);
      messageDiv.appendChild(badge);
    } else {
      messageDiv.appendChild(labelSpan);
      messageDiv.appendChild(bubbleDiv);
    }

    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Send Message Logic
  async function sendMessage() {
    if (isThinking || !isOllamaOnline) return;

    const query = chatInput.value.trim();
    if (!query) return;

    const modelSelected = selectModel.value;
    if (!modelSelected) {
      showToast('Please select a local AI model first!', 'error');
      return;
    }

    // Append user message
    appendMessage('user', query);
    chatInput.value = '';
    chatInput.style.height = '38px';

    // Lock UI during generation
    isThinking = true;
    chatInput.disabled = true;
    btnSend.disabled = true;

    // Display thinking indicator bubble
    const thinkingDiv = document.createElement('div');
    thinkingDiv.className = 'message assistant thinking-bubble';
    thinkingDiv.innerHTML = `
      <span class="message-label">Wave AI Co-Pilot</span>
      <div class="message-bubble" style="opacity: 0.6; font-style: italic;">
        Generative inference in progress...
      </div>
    `;
    chatMessages.appendChild(thinkingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Add query to session history
    conversationHistory.push({ role: 'user', content: query });

    // Save after user message
    await autoSaveConversation();

    try {
      // Request chat generation
      const result = await window.electronAPI.chat(modelSelected, conversationHistory);
      const answer = result.content || result;
      const provider = result.provider || 'ollama';
      
      // Remove thinking bubble
      thinkingDiv.remove();

      // Append assistant reply with provider badge
      appendMessage('assistant', answer, provider);

      // Record reply to history
      conversationHistory.push({ role: 'assistant', content: answer });

      // Save after assistant response
      await autoSaveConversation();

    } catch (err) {
      if (thinkingDiv) thinkingDiv.remove();
      appendMessage('assistant', `⚠️ **Error during response generation:**

${err.message || 'Ollama connection failed.'}`);
      showToast('Inference Error occurred', 'error');
    } finally {
      isThinking = false;
      chatInput.disabled = false;
      btnSend.disabled = false;
      chatInput.focus();
    }
  }

  // Send Button Click
  btnSend.addEventListener('click', sendMessage);

  // Keypress Keyboard Shortcuts: Enter (send), Shift+Enter (new line)
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Expandable textarea height adjustments based on content
  chatInput.addEventListener('input', () => {
    chatInput.style.height = '38px';
    const scrollHeight = chatInput.scrollHeight;
    if (scrollHeight > 38) {
      chatInput.style.height = `${Math.min(scrollHeight, 120)}px`;
    }
  });

  // --- Initial Setup and Active Polling ---
  refreshModels();

  // Keep polling status in background every 4s
  setInterval(refreshModels, 4000);
});
