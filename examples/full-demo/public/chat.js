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

// Vanilla mirror of the SDK's defaultDisplay/displayOf. Inlined so the demo
// stays bundler-free; keep in sync with `src/agent/events.ts` if titles change.
function defaultDisplay(event) {
  switch (event.type) {
    case "agent:start":
      return { title: `Starting ${event.agentName}` };
    case "agent:end": {
      const seconds = Math.max(1, Math.round((event.elapsedMs ?? 0) / 1000));
      const errored = event.result?.stopReason === "error";
      return {
        title: errored
          ? `Completed with errors in ${seconds}s`
          : `Completed in ${seconds}s`,
      };
    }
    case "message:delta":
      return { title: "Message delta" };
    case "message":
      return { title: "Message" };
    case "message:preamble":
      return { title: "Preamble" };
    case "tool:start":
      return { title: `Running ${event.toolName}` };
    case "tool:progress":
      return { title: `Still running (${Math.round((event.elapsedMs ?? 0) / 1000)}s)` };
    case "tool:end": {
      const seconds = Math.max(1, Math.round((event.elapsedMs ?? 0) / 1000));
      return {
        title: "error" in event ? `Tool failed after ${seconds}s` : `Completed tool in ${seconds}s`,
      };
    }
    case "error":
      return { title: "Error", content: event.error?.message };
    default:
      return { title: event.type };
  }
}

function displayOf(event) {
  return event.display ?? defaultDisplay(event);
}

// Performs the fetch + stream loop for a given user message. Does not render
// the user bubble — callers do that once, and retries reuse the original one.
async function runRequest(message) {
  sendBtn.disabled = true;

  // One activity card per request; `phases` is the ordered list of tool
  // invocations so we can render them as a timeline inside a single card.
  let activityCard = null;
  const phases = [];
  const phaseById = new Map();
  let assistantEl = null;
  let assistantBuf = "";
  let renderedAssistant = false;
  let errorShown = false;
  // The top-level run's id, captured from the first `agent:start` without
  // `parentRunId`. Used to ignore `agent:end` for bubbled subagent runs —
  // those would otherwise overwrite the activity card and trigger the
  // result-text fallback bubble using the subagent's output.
  let topRunId = null;

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
    // Log every event to the browser console (object form, so DevTools
    // renders it expandable). message:delta is skipped — its text is
    // assembled into the `message` event that follows, so logging deltas
    // is just per-token noise.
    if (event.type !== "message:delta") {
      console.log("[agent]", event.type, event);
    }
    switch (event.type) {
      case "agent:start": {
        // Capture the top-level run id once. Subagent `agent:start` events
        // (which carry `parentRunId`) bubble through too, but we want the
        // top-level run's id for gating `agent:end` below.
        if (!event.parentRunId && topRunId === null) {
          topRunId = event.runId;
        }
        // Open the per-turn activity card up front so the user sees an
        // immediate "Thinking" indicator while we wait for the first model
        // response. Tool events below replace the title/content live; the
        // final timeline (or "Completed in Xs" if no tools ran) is rendered
        // on agent:end.
        if (!activityCard) {
          activityCard = addToolCard(null, "Thinking", undefined);
        }
        break;
      }
      case "tool:start": {
        // A tool call interrupts the current turn's assistant text. We never
        // promoted the buffered deltas to a visible bubble (see message:delta
        // handler), so just clear the buffer — the matching message:preamble
        // event that closes this turn (or arrives concurrently) will render
        // the buffered text into the activity card.
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
        // Buffer text but do NOT render until we know this turn's classifier.
        // - On `message:preamble` (turn ends in tool calls): the preamble
        //   case above renders the buffered text into the activity card.
        // - On `message` (final turn): the case below renders the buffered
        //   text into a fresh assistant bubble.
        // - On `tool:start` arriving before either (tool-only turn with no
        //   text), the buffer stays empty and nothing renders.
        assistantBuf += event.text;
        break;
      }
      case "message:preamble": {
        // Preamble text accompanies a tool call: model narrating its plan
        // before invoking tools. Render it as the activity card's content
        // (next to the tool title) rather than as a peer assistant bubble.
        // Reset any in-progress assistant bubble state — the preamble does
        // not start one.
        assistantEl = null;
        assistantBuf = "";
        const text =
          typeof event.message?.content === "string" ? event.message.content : "";
        if (text.length > 0) {
          if (!activityCard) {
            activityCard = addToolCard(null, "Preamble", text);
          } else {
            setActivityContent(activityCard, text);
          }
        }
        break;
      }
      case "message": {
        // Final-answer message. Render the full assistant content as a chat
        // bubble. `message:delta` events accumulated text into `assistantBuf`
        // without rendering; we render it now in one shot. If for some reason
        // no deltas arrived (e.g. non-streaming fallback), fall back to the
        // event's own `message.content`.
        const fallback =
          typeof event.message?.content === "string" ? event.message.content : "";
        const text = assistantBuf.length > 0 ? assistantBuf : fallback;
        if (text.length > 0 && event.message?.role === "assistant") {
          if (!assistantEl) assistantEl = addAssistantMessage();
          renderMarkdown(assistantEl, text);
          renderedAssistant = true;
          scroll();
        }
        assistantEl = null;
        assistantBuf = "";
        break;
      }
      case "agent:end": {
        // Subagent `agent:end` events bubble up to the parent stream. Skip
        // them — they would otherwise overwrite the activity card title with
        // the subagent's elapsed time and (when no parent message has
        // rendered yet) trigger the fallback below using the subagent's
        // `result.text`, producing a duplicate chat bubble.
        if (event.runId !== topRunId) break;
        // Replace the live title/content with the final state. The title
        // always reports the elapsed time so the user sees how long the
        // turn took, with or without tool calls. When tools ran, the
        // timeline of phases is rendered as content underneath.
        if (activityCard) {
          const elapsedSec = Math.max(1, Math.round((event.elapsedMs ?? 0) / 1000));
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
