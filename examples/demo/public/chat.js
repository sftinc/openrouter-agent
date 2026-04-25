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

// Sets the activity card title in place.
function setActivityTitle(card, title) {
  const titleEl = card.querySelector(".tool-title");
  if (titleEl) titleEl.textContent = title;
}

// Replaces the activity card content. Pass undefined/empty to drop it.
function setActivityContent(card, content) {
  let contentEl = card.querySelector(".tool-content");
  if (content === undefined || content === null || content === "") {
    if (contentEl) contentEl.remove();
    return;
  }
  if (!contentEl) {
    contentEl = el("div", "tool-content");
    card.appendChild(contentEl);
  }
  contentEl.textContent = content;
}

// Renders the final timeline of phases as the card's content. Used on
// agent:end so the user can see what ran (and whether each step succeeded).
function renderTimeline(card, phases) {
  card.classList.toggle("done", phases.every((p) => p.done));
  card.classList.toggle("error", phases.some((p) => p.error));
  if (phases.length === 0) return;
  setActivityContent(
    card,
    phases
      .map((p) => {
        const mark = p.error ? "✗" : p.done ? "✓" : "…";
        return `${mark} ${p.title}`;
      })
      .join("\n"),
  );
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

  // One activity card per request; `phases` is the ordered list of tool
  // invocations (and future agent phases) so we can render them as a
  // timeline inside a single card. `agentStartedAt` is captured on
  // agent:start so we can render "Thought for Xs" when the run finishes
  // with no tool calls.
  let activityCard = null;
  let agentStartedAt = null;
  const phases = [];
  const phaseById = new Map();
  let assistantEl = null;
  let assistantBuf = "";
  let renderedAssistant = false;
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
      case "agent:start": {
        // Open the per-turn activity card up front so the user sees an
        // immediate "Thinking" indicator while we wait for the first model
        // response. Tool events below replace the title/content live; the
        // final timeline (or "Thought for Xs" if no tools ran) is rendered
        // on agent:end.
        if (!activityCard) {
          activityCard = addToolCard(null, "Thinking", undefined);
        }
        if (agentStartedAt === null) agentStartedAt = Date.now();
        break;
      }
      case "tool:start": {
        // A tool call interrupts the current assistant bubble; next text
        // belongs to a fresh bubble for the post-tool turn.
        assistantEl = null;
        assistantBuf = "";
        const d = displayOf(event);
        const phase = {
          id: event.toolUseId,
          title: d?.title ?? `Running ${event.toolName}`,
          content: d?.content,
          done: false,
          error: false,
        };
        phases.push(phase);
        phaseById.set(event.toolUseId, phase);
        if (!activityCard) {
          activityCard = addToolCard(event.toolName, phase.title, phase.content);
        } else {
          setActivityTitle(activityCard, phase.title);
          setActivityContent(activityCard, phase.content);
        }
        break;
      }
      case "tool:end": {
        const phase = phaseById.get(event.toolUseId);
        if (!phase) break;
        const d = displayOf(event);
        const hasError = "error" in event;
        phase.title = d?.title ?? (hasError ? "Tool failed" : phase.title);
        if (d?.content !== undefined) phase.content = d.content;
        phase.done = true;
        phase.error = hasError;
        setActivityTitle(activityCard, phase.title);
        setActivityContent(activityCard, phase.content);
        break;
      }
      case "message:delta": {
        if (typeof event.text !== "string" || event.text.length === 0) break;
        if (!assistantEl) {
          assistantEl = addAssistantMessage();
          assistantBuf = "";
        }
        assistantBuf += event.text;
        renderedAssistant = true;
        renderMarkdown(assistantEl, assistantBuf);
        scroll();
        break;
      }
      case "message": {
        // The full assistant message. If we rendered deltas, the bubble is
        // already up-to-date — just reset state for the next turn. If for
        // some reason no deltas arrived (e.g. non-streaming fallback), render
        // the whole content here.
        if (
          event.message?.role === "assistant" &&
          typeof event.message.content === "string" &&
          event.message.content.length > 0 &&
          assistantBuf.length === 0
        ) {
          if (!assistantEl) assistantEl = addAssistantMessage();
          renderMarkdown(assistantEl, event.message.content);
          renderedAssistant = true;
          scroll();
        }
        assistantEl = null;
        assistantBuf = "";
        break;
      }
      case "agent:end": {
        // Replace the live title/content with the final state. The title
        // always reports the elapsed time so the user sees how long the
        // turn took, with or without tool calls. When tools ran, the
        // timeline of phases is rendered as content underneath.
        if (activityCard) {
          const elapsedMs = agentStartedAt ? Date.now() - agentStartedAt : 0;
          const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));
          const hasError = phases.some((p) => p.error);
          const title = hasError
            ? `Completed with errors in ${elapsedSec}s`
            : `Completed in ${elapsedSec}s`;
          setActivityTitle(activityCard, title);
          if (phases.length === 0) {
            setActivityContent(activityCard, undefined);
            activityCard.classList.add("done");
          } else {
            renderTimeline(activityCard, phases);
          }
        }
        if (event.result?.stopReason === "error" && event.result?.error?.message) {
          showError(event.result.error.message);
        } else if (event.result?.stopReason === "aborted") {
          showError("request was aborted before it finished");
        } else if (
          !renderedAssistant &&
          typeof event.result?.text === "string" &&
          event.result.text.length > 0
        ) {
          const el = addAssistantMessage();
          renderMarkdown(el, event.result.text);
          renderedAssistant = true;
          scroll();
        }
        break;
      }
      case "error": {
        showError(event.error?.message ?? "unknown error");
        break;
      }
      // tool:progress ignored in this demo
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
