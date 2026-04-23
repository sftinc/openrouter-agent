const messagesEl = document.getElementById("messages");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");

const SESSION_KEY = "openrouter-agent-demo-session";
let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, sessionId);
}

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

function addError(msg) {
  messagesEl.appendChild(el("div", "msg error", "Error: " + msg));
  scroll();
}

function scroll() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function displayOf(event) {
  return event.display ?? null;
}

async function send(message) {
  addUserMessage(message);
  input.value = "";
  sendBtn.disabled = true;

  const toolCards = new Map(); // toolUseId -> element
  let assistantEl = null;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId }),
    });
    if (!response.ok || !response.body) {
      addError(`HTTP ${response.status}`);
      return;
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
    addError(err.message ?? String(err));
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }

  function handleEvent(event) {
    switch (event.type) {
      case "tool:start": {
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
      case "message": {
        if (
          event.message?.role === "assistant" &&
          typeof event.message.content === "string" &&
          event.message.content.length > 0
        ) {
          if (!assistantEl) assistantEl = addAssistantMessage();
          assistantEl.textContent = event.message.content;
          scroll();
        }
        break;
      }
      case "agent:end": {
        if (event.result?.stopReason === "error" && event.result?.error?.message) {
          addError(event.result.error.message);
        }
        if (
          !assistantEl &&
          typeof event.result?.text === "string" &&
          event.result.text.length > 0
        ) {
          assistantEl = addAssistantMessage();
          assistantEl.textContent = event.result.text;
          scroll();
        }
        break;
      }
      case "error": {
        addError(event.error?.message ?? "unknown error");
        break;
      }
      // agent:start, tool:progress ignored in this demo
    }
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const msg = input.value.trim();
  if (msg) send(msg);
});

input.focus();
