const messagesEl = document.getElementById("messages");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const newChatBtn = document.getElementById("new-chat");

const SESSION_KEY = "openrouter-agent-demo-session";
// The server owns session ids: it mints one on the first message and echoes
// it back on every response via the X-Session-Id header. We just hold onto
// whatever the server last gave us, and clearing this to null starts a new
// conversation on the next send.
let sessionId = localStorage.getItem(SESSION_KEY);

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function addUserMessage(text) {
  const div = el("div", "msg user", text);
  messagesEl.appendChild(div);
  scroll();
}

function renderMarkdown(el, text) {
  if (window.marked && window.DOMPurify) {
    el.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text));
  } else {
    el.textContent = text;
  }
}

function addAssistantMessage() {
  const div = el("div", "msg assistant", "");
  messagesEl.appendChild(div);
  scroll();
  return div;
}

function addToolCard(toolName, title, content) {
  const card = el("div", "tool");
  const titleEl = el("div", "tool-title", title ?? `Running ${toolName}`);
  card.appendChild(titleEl);
  if (content) {
    const contentEl = el("div", "tool-content", content);
    card.appendChild(contentEl);
  }
  messagesEl.appendChild(card);
  scroll();
  return card;
}

function finishToolCard(card, title, content, hasError) {
  card.classList.add("done");
  if (hasError) card.classList.add("error");
  const titleEl = card.querySelector(".tool-title");
  if (titleEl && title) titleEl.textContent = title;
  if (content !== undefined) {
    let contentEl = card.querySelector(".tool-content");
    if (!contentEl) {
      contentEl = el("div", "tool-content");
      card.appendChild(contentEl);
    }
    contentEl.textContent = content;
  }
}

function addErrorWithRetry(msg, onRetry) {
  const wrap = el("div", "msg error");
  wrap.appendChild(document.createTextNode("Error: " + msg + " "));
  const btn = el("button", "retry-btn", "Retry");
  btn.type = "button";
  btn.addEventListener("click", () => {
    btn.disabled = true;
    onRetry();
  });
  wrap.appendChild(btn);
  messagesEl.appendChild(wrap);
  scroll();
}

function scroll() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function displayOf(event) {
  return event.display ?? null;
}

// Performs the fetch + stream loop for a given user message. Does not render
// the user bubble — callers do that once, and retries reuse the original one.
async function runRequest(message) {
  sendBtn.disabled = true;

  const toolCards = new Map();
  let assistantEl = null;
  let assistantBuf = "";
  let errorShown = false;

  const showError = (msg) => {
    if (errorShown) return;
    errorShown = true;
    addErrorWithRetry(msg, () => runRequest(message));
  };

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId }),
    });

    if (response.status === 409) {
      showError("another request is in progress for this session");
      return;
    }
    if (!response.ok || !response.body) {
      showError(`HTTP ${response.status}`);
      return;
    }

    const returnedSessionId = response.headers.get("X-Session-Id");
    if (returnedSessionId) {
      sessionId = returnedSessionId;
      localStorage.setItem(SESSION_KEY, sessionId);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) handleEvent(JSON.parse(line));
      }
    }
    if (buffer.trim()) handleEvent(JSON.parse(buffer));
  } catch (err) {
    showError(err.message ?? String(err));
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }

  function handleEvent(event) {
    switch (event.type) {
      case "tool:start": {
        // A tool call interrupts the current assistant bubble; next text
        // belongs to a fresh bubble for the post-tool turn.
        assistantEl = null;
        assistantBuf = "";
        const d = displayOf(event);
        const card = addToolCard(
          event.toolName,
          d?.title ?? `Running ${event.toolName}`,
          d?.content
        );
        toolCards.set(event.toolUseId, card);
        break;
      }
      case "tool:end": {
        const card = toolCards.get(event.toolUseId);
        if (!card) break;
        const d = displayOf(event);
        const hasError = "error" in event;
        finishToolCard(
          card,
          d?.title ?? (hasError ? "Tool failed" : "Completed"),
          d?.content,
          hasError
        );
        break;
      }
      case "message:delta": {
        if (typeof event.text !== "string" || event.text.length === 0) break;
        if (!assistantEl) {
          assistantEl = addAssistantMessage();
          assistantBuf = "";
        }
        assistantBuf += event.text;
        renderMarkdown(assistantEl, assistantBuf);
        scroll();
        break;
      }
      case "message": {
        // The full assistant message. If we rendered deltas, the bubble is
        // already up-to-date — just reset state for the next turn. If for
        // some reason no deltas arrived (e.g. non-streaming fallback), fall
        // through to render the whole content here.
        if (
          event.message?.role === "assistant" &&
          typeof event.message.content === "string" &&
          event.message.content.length > 0 &&
          assistantBuf.length === 0
        ) {
          if (!assistantEl) assistantEl = addAssistantMessage();
          renderMarkdown(assistantEl, event.message.content);
          scroll();
        }
        assistantEl = null;
        assistantBuf = "";
        break;
      }
      case "agent:end": {
        if (event.result?.stopReason === "error" && event.result?.error?.message) {
          showError(event.result.error.message);
        } else if (event.result?.stopReason === "aborted") {
          showError("request was aborted before it finished");
        } else if (
          !assistantEl &&
          typeof event.result?.text === "string" &&
          event.result.text.length > 0
        ) {
          assistantEl = addAssistantMessage();
          renderMarkdown(assistantEl, event.result.text);
          scroll();
        }
        break;
      }
      case "error": {
        showError(event.error?.message ?? "unknown error");
        break;
      }
      // agent:start, tool:progress ignored in this demo
    }
  }
}

newChatBtn.addEventListener("click", () => {
  sessionId = null;
  localStorage.removeItem(SESSION_KEY);
  messagesEl.replaceChildren();
  input.value = "";
  input.focus();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (sendBtn.disabled) return;
  const msg = input.value.trim();
  if (!msg) return;
  // Disable synchronously before any async work starts so a double-click or
  // Enter-mash can't submit twice.
  sendBtn.disabled = true;
  input.value = "";
  addUserMessage(msg);
  runRequest(msg);
});

input.focus();
