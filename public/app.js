// Pi Durable Event Lab browser interaction layer.
const $ = (id) => document.getElementById(id);
const eventsEl = $("events");
const agentStorageKey = "pi-cloudflare-demo-agent";
let agentId = "";
let socket;
let seen = new Set();
let statusTimer;
let pollController;
let connectionGeneration = 0;
let currentStatus = "";
let requestBusy = false;

function showError(title, message) {
  addEvent({ id: crypto.randomUUID(), at: new Date().toISOString(), type: title, level: "error", details: { message: String(message || "Unknown error") } });
}

function addEvent(event) {
  if (!event?.id || seen.has(event.id)) return;
  seen.add(event.id);
  eventsEl.querySelector(".empty")?.remove();
  const row = document.createElement("div"); row.className = `event ${event.level || "info"}`;
  const date = new Date(event.at);
  const time = document.createElement("span"); time.className = "time"; time.textContent = Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString();
  const body = document.createElement("div");
  const title = document.createElement("span"); title.className = "event-name"; title.textContent = event.type || "event"; body.append(title);
  if (event.operationId) { const op = document.createElement("span"); op.className = "detail"; op.textContent = `operation ${event.operationId}`; body.append(op); }
  if (event.details && Object.keys(event.details).length) { const detail = document.createElement("span"); detail.className = "detail"; detail.textContent = Object.entries(event.details).map(([key, value]) => `${key}: ${value}`).join(" · "); body.append(detail); }
  row.append(time, body); eventsEl.append(row); eventsEl.scrollTop = eventsEl.scrollHeight;
}

function setSocketState(state) { $("socket").textContent = `viewer: ${state}`; }
function activeRun() { return Boolean(agentId) && currentStatus === "running"; }

function updateControls() {
  const exists = Boolean(agentId), active = activeRun();
  $("launch").disabled = requestBusy || active;
  $("new-run").disabled = requestBusy || active;
  $("new-run").textContent = requestBusy ? "Starting…" : "Start fresh run";
  $("disconnect").disabled = !exists || !socket || socket.readyState !== WebSocket.OPEN;
  $("reconnect").disabled = !exists || Boolean(socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState));
  for (const id of ["arm-timeout", "timeout", "oom"]) $(id).disabled = !active;
}

function setStatus(status) {
  currentStatus = status?.status || "unknown";
  const dot = $("status").querySelector(".dot"), label = $("status").lastElementChild;
  dot.className = `dot ${currentStatus}`;
  if (label.textContent !== currentStatus) label.textContent = currentStatus;
  const errorTitle = status?.lastError || "";
  if (label.title !== errorTitle) label.title = errorTitle;
  if (status?.operationId) {
    const id = document.createElement("code"); id.textContent = agentId;
    const operation = document.createElement("span"); operation.className = "detail"; operation.textContent = `operation ${status.operationId}`;
    $("agent-id").replaceChildren(id, operation);
  }
  if (status?.lastResponse && $("answer").textContent !== status.lastResponse) $("answer").textContent = status.lastResponse;
  else if (status?.lastError) {
    const explanation = status.lastError === "model_error"
      ? "Workers AI could not run in this local Wrangler mode. The AI binding has no local simulator; start with remote bindings to run GLM 5.3 Flash."
      : `Run failed: ${status.lastError}`;
    if ($("answer").textContent !== explanation) $("answer").textContent = explanation;
  }
  updateControls();
}

function addStateCard(parent, label, value) {
  const card = document.createElement("div"); card.className = "state-card";
  const labelEl = document.createElement("div"); labelEl.className = "state-label"; labelEl.textContent = label;
  const valueEl = document.createElement("div"); valueEl.className = "state-value"; valueEl.textContent = value;
  card.append(labelEl, valueEl); parent.append(card);
}

function renderInspection(data) {
  const brain = data.brain || {}, summary = $("brain-summary"); summary.replaceChildren();
  if (brain.model) $("model-name").textContent = `${brain.model.provider}/${brain.model.modelId}`;
  addStateCard(summary, "Model", brain.model ? `${brain.model.provider}/${brain.model.modelId}` : "not selected yet");
  addStateCard(summary, "Thinking", brain.thinkingLevel || "default");
  addStateCard(summary, "Sessions", (brain.sessions || []).map((s) => `${s.id}${s.busy ? " · busy" : ""}`).join(", ") || "none");
  addStateCard(summary, "Pending submissions", (brain.pending || []).map((p) => `${p.status} · ${p.operationId}`).join("\n") || "none");
  addStateCard(summary, "Extensions", Array.isArray(brain.extensions) ? (brain.extensions.join(", ") || "host defaults") : JSON.stringify(brain.extensions));
  addStateCard(summary, "Usage", JSON.stringify(brain.usage || {}));
  const generation = brain.live?.generation;
  addStateCard(summary, "Generation", generation ? `attempt ${generation.attempt}${generation.retry ? ` · retry ${generation.retry.at}` : ""}${generation.deferred ? ` · deferred until ${generation.deferred.pollAt}` : ""}` : "idle");
  addStateCard(summary, "Inbox", (brain.live?.inbox || []).length ? `${brain.live.inbox.length} queued item(s)` : "empty");
  $("instructions").textContent = brain.instructions || "No base instructions are configured.";
  const transcript = $("transcript"); transcript.replaceChildren();
  const messages = (brain.transcript || []).flatMap((entry) => (entry.messages || []).map((message) => ({ entry, message })));
  if (!messages.length) transcript.innerHTML = '<div class="empty">No transcript entries yet.</div>';
  for (const { entry, message } of messages.slice(-30)) {
    const row = document.createElement("div"); row.className = "list-row";
    const title = document.createElement("strong"); title.textContent = `${message.role} · ${entry.kind}`;
    const text = document.createElement("pre"); text.textContent = message.content || "(no display text)";
    row.append(title, text); transcript.append(row);
  }
  const tools = $("tools"); tools.replaceChildren();
  for (const item of data.hands?.loadedTools || []) {
    const row = document.createElement("div"); row.className = "list-row";
    const title = document.createElement("strong"); title.textContent = item.name;
    const extension = document.createElement("span"); extension.className = "detail"; extension.textContent = `extension: ${item.extension}`;
    const replay = document.createElement("span"); replay.className = "pill"; replay.textContent = `replay: ${item.replay}`;
    const mode = document.createElement("span"); mode.className = "pill"; mode.textContent = `execution: ${item.executionMode}`;
    const selected = document.createElement("span"); selected.className = "pill"; selected.textContent = item.selected ? "selected" : "not selected";
    row.append(title, extension, replay, mode, selected); tools.append(row);
  }
  if (!tools.childElementCount) tools.innerHTML = '<div class="empty">No tools are registered yet.</div>';
  const nested = $("nested-tools"); nested.replaceChildren();
  for (const item of data.hands?.nestedTools || []) {
    const row = document.createElement("div"); row.className = "list-row";
    const title = document.createElement("strong"); title.textContent = `${item.group}.${item.name}`;
    const description = document.createElement("span"); description.className = "detail"; description.textContent = item.description;
    row.append(title, description); nested.append(row);
  }
  if (!nested.childElementCount) nested.innerHTML = '<div class="empty">No nested tools are available.</div>';
  const calls = $("calls"); calls.replaceChildren();
  for (const call of data.hands?.currentCalls || []) {
    const row = document.createElement("div"); row.className = "list-row";
    const title = document.createElement("strong"); title.textContent = `${call.name} · ${call.status}`; row.append(title);
    if (call.output) { const output = document.createElement("pre"); output.textContent = call.output; row.append(output); }
    if (call.diagnostics?.length) { const diagnostics = document.createElement("pre"); diagnostics.textContent = JSON.stringify(call.diagnostics, null, 2); row.append(diagnostics); }
    calls.append(row);
  }
  if (!calls.childElementCount) calls.innerHTML = '<div class="empty">No active tool calls.</div>';
}

async function requestJson(path, options = {}, signal) {
  const response = await fetch(path, { ...options, signal });
  let value;
  try { value = await response.json(); } catch { throw new Error(`Server returned unreadable data (${response.status})`); }
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}

async function refreshStatus(signal, generation) {
  if (!agentId || socket?.readyState !== WebSocket.OPEN) return;
  try { const value = await requestJson(`/agents/${agentId}`, {}, signal); if (generation === connectionGeneration && !signal.aborted) setStatus(value); }
  catch (error) { if (!signal.aborted) showError("demo.status.refresh_failed", error.message); }
}
async function refreshInspection(signal, generation) {
  if (!agentId || socket?.readyState !== WebSocket.OPEN) return;
  try { const value = await requestJson(`/agents/${agentId}/inspect`, {}, signal); if (generation === connectionGeneration && !signal.aborted) renderInspection(value); }
  catch (error) { if (!signal.aborted) showError("demo.inspection.refresh_failed", error.message); }
}
function stopPolling() {
  clearInterval(statusTimer); statusTimer = undefined; pollController?.abort(); pollController = undefined;
}
function startPolling(generation) {
  stopPolling(); pollController = new AbortController(); const signal = pollController.signal;
  const refresh = () => {
    if (generation !== connectionGeneration || socket?.readyState !== WebSocket.OPEN) return;
    void refreshStatus(signal, generation); void refreshInspection(signal, generation);
  };
  statusTimer = setInterval(refresh, 1200); refresh();
}

function connect() {
  if (!agentId) return;
  if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) socket.close(1000, "Reconnect requested");
  stopPolling(); const generation = ++connectionGeneration;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const nextSocket = new WebSocket(`${scheme}//${location.host}/agents/pi-agent/${agentId}`); socket = nextSocket;
  setSocketState("reconnecting…"); updateControls();
  nextSocket.onopen = () => {
    if (socket !== nextSocket || generation !== connectionGeneration) return;
    setSocketState("live · receiving saved and new events"); startPolling(generation); updateControls();
  };
  nextSocket.onmessage = (message) => {
    if (socket !== nextSocket) return;
    try { addEvent(JSON.parse(message.data)); } catch { showError("demo.socket.invalid_event", "Received an event that could not be read."); }
  };
  nextSocket.onclose = () => {
    if (socket !== nextSocket || generation !== connectionGeneration) return;
    stopPolling(); setSocketState("detached · run continues; reconnect to watch again"); updateControls();
  };
  nextSocket.onerror = () => { if (socket === nextSocket) setSocketState("connection trouble · reconnect to try again"); };
}

async function launch() {
  if (requestBusy || activeRun()) return;
  requestBusy = true; $("launch").textContent = "Starting…"; $("new-run").textContent = "Starting…"; updateControls();
  try {
    const result = await requestJson("/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: $("prompt").value.trim() }) });
    agentId = result.agentId; currentStatus = "running"; localStorage.setItem(agentStorageKey, agentId); seen = new Set(); eventsEl.replaceChildren();
    $("answer").textContent = "Waiting for a run to finish.";
    const code = document.createElement("code"); code.textContent = agentId; $("agent-id").replaceChildren(code);
    setStatus({ status: "running", operationId: result.operationId }); connect();
  } catch (error) { showError("demo.launch.failed", error.message); }
  finally { requestBusy = false; $("launch").textContent = "Launch durable run"; updateControls(); }
}

async function interrupt(cause) {
  if (!agentId || !activeRun()) return;
  try {
    const result = await requestJson(`/agents/${agentId}/interrupt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cause }) });
    if (!result.interrupted) addEvent({ id: crypto.randomUUID(), at: new Date().toISOString(), type: "demo.interrupt.no_active_run", level: "warn", details: { cause } });
    if (pollController) await refreshStatus(pollController.signal, connectionGeneration);
  } catch (error) { showError("demo.interrupt.failed", error.message); }
}
async function armDeadline() {
  if (!agentId || !activeRun()) return;
  try {
    const result = await requestJson(`/agents/${agentId}/deadline`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seconds: 5 }) });
    if (!result.scheduled) addEvent({ id: crypto.randomUUID(), at: new Date().toISOString(), type: "demo.deadline.no_active_run", level: "warn" });
  } catch (error) { showError("demo.deadline.arm_failed", error.message); }
}

$("launch").addEventListener("click", launch);
$("new-run").addEventListener("click", launch);
$("disconnect").addEventListener("click", () => socket?.close(1000, "Demo viewer disconnected"));
$("reconnect").addEventListener("click", connect);
$("timeout").addEventListener("click", () => interrupt("deadline"));
$("arm-timeout").addEventListener("click", armDeadline);
$("oom").addEventListener("click", () => interrupt("resource-limit"));
$("clear-view").addEventListener("click", () => { seen.clear(); eventsEl.innerHTML = '<div class="empty">Visible rows cleared. Reconnect to replay the Durable Object event history.</div>'; });
const tabs = [...document.querySelectorAll('[role="tab"][data-tab]')];
function selectTab(button, moveFocus = false) {
  for (const tab of tabs) {
    const selected = tab === button;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const name of ["brain", "hands"]) $(`view-${name}`).hidden = button.dataset.tab !== name;
  if (moveFocus) button.focus();
}
for (const button of tabs) {
  button.addEventListener("click", () => selectTab(button));
  button.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(button);
    let next;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = tabs[(index + 1) % tabs.length];
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === "Home") next = tabs[0];
    else if (event.key === "End") next = tabs[tabs.length - 1];
    if (next) { event.preventDefault(); selectTab(next, true); }
  });
}

const savedAgentId = localStorage.getItem(agentStorageKey);
if (savedAgentId && /^[a-f0-9-]+$/.test(savedAgentId)) {
  agentId = savedAgentId; const code = document.createElement("code"); code.textContent = agentId; $("agent-id").replaceChildren(code); setSocketState("reconnecting…"); connect();
}
updateControls();
