// Pi Durable Event Lab browser interaction layer.
const $ = (id) => document.getElementById(id);
const eventsEl = $("events");
const agentStorageKey = "pi-cloudflare-demo-agent";
let agentId = "";
let socket;
const eventRows = new Map();
let statusTimer;
let pollController;
let connectionGeneration = 0;
let currentStatus = "";
let requestBusy = false;

function showError(title, message) {
  addEvent({ id: crypto.randomUUID(), at: new Date().toISOString(), type: title, level: "error", details: { message: String(message || "Unknown error") } });
}

function filterEvents() {
  const query = $("event-search").value.trim().toLocaleLowerCase();
  const level = $("event-level").value;
  const rows = [...eventsEl.querySelectorAll(".event")];
  let visible = 0;
  for (const row of rows) {
    const matches = (!query || row.textContent.toLocaleLowerCase().includes(query)) && (!level || row.dataset.level === level);
    row.hidden = !matches;
    if (matches) visible++;
  }
  $("event-count").textContent = rows.length === visible
    ? `${rows.length} event${rows.length === 1 ? "" : "s"}`
    : `${visible} shown · ${rows.length} total`;
}

function formatEventValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function addEvent(event) {
  if (!event?.id) return;
  const existing = eventRows.get(event.id);
  const level = ["warn", "error"].includes(event.level) ? event.level : "info";
  if (existing) {
    existing.row.className = `event ${level}`;
    existing.row.dataset.level = level;
    existing.title.textContent = event.type || "event";
    const type = event.type || "event";
    existing.icon.textContent = event.level === "error" ? "!" : event.level === "warn" ? "△" : type.toLowerCase().includes("tool") ? "⚒" : type.toLowerCase().includes("message") ? "▤" : "•";
    existing.payload.textContent = eventPayload(event);
    existing.payloadDetails.hidden = !existing.payload.textContent;
    if (event.preview !== undefined) {
      existing.preview.textContent = event.preview;
      existing.preview.hidden = !event.preview;
    }
    filterEvents();
    return;
  }
  eventsEl.querySelector(".empty")?.remove();
  const row = document.createElement("div"); row.className = `event ${level}`; row.dataset.level = level;
  const date = new Date(event.at);
  const time = document.createElement("span"); time.className = "time"; time.textContent = Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString();
  const body = document.createElement("div"); body.className = "event-body";
  const heading = document.createElement("div"); heading.className = "event-heading";
  const icon = document.createElement("span"); icon.className = "event-icon"; icon.setAttribute("aria-hidden", "true");
  const type = event.type || "event";
  icon.textContent = event.level === "error" ? "!" : event.level === "warn" ? "△" : type.toLowerCase().includes("tool") ? "⚒" : type.toLowerCase().includes("message") ? "▤" : "•";
  const title = document.createElement("span"); title.className = "event-name"; title.textContent = type;
  heading.append(icon, title); body.append(heading);
  const preview = document.createElement("span"); preview.className = "event-preview";
  preview.textContent = event.preview || ""; preview.hidden = !preview.textContent;
  body.append(preview);
  const payloadDetails = document.createElement("details"); payloadDetails.className = "event-payload";
  const payloadSummary = document.createElement("summary"); payloadSummary.textContent = "Inspect details";
  const payload = document.createElement("pre"); payload.className = "detail"; payload.textContent = eventPayload(event);
  payloadDetails.append(payloadSummary, payload); payloadDetails.hidden = !payload.textContent;
  body.append(payloadDetails); row.append(time, body); eventsEl.append(row); eventRows.set(event.id, { row, title, icon, preview, payload, payloadDetails });
  filterEvents(); eventsEl.scrollTop = eventsEl.scrollHeight;
}

function eventPayload(event) {
  const details = Object.entries(event.details || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => `${key}: ${formatEventValue(value)}`);
  if (event.operationId) details.unshift(`operation: ${event.operationId}`);
  return details.join(" · ");
}

function messageContent(message) {
  return (message?.content || []).map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "toolCall") return `Tool call ${part.name}: ${JSON.stringify(part.arguments)}`;
    if (part.type === "toolResult") return `Tool result ${part.toolName || ""}: ${(part.content || []).map((item) => item.text || "").join("\n")}`;
    return "";
  }).filter(Boolean).join("\n");
}

function messageText(message) {
  return (message?.content || []).filter((part) => part.type === "text").map((part) => part.text).filter(Boolean).join("\n");
}

function showLiveResponse(text) {
  $("answer-title").textContent = "Live response";
  $("answer").textContent = text || "Waiting for the first response token…";
}

// Pi Durable renders state, not events: each socket message carries a compact copy of the
// conversation view. Rows are keyed by entry id or tool slot, so a new view updates them in place.
function renderPiView(view) {
  if (!view) return;
  const at = new Date().toISOString();
  for (const entry of view.entries || []) {
    for (const [index, message] of (entry.messages || []).entries()) {
      addEvent({ id: `pi-entry-${entry.id}-${index}`, at, type: `Pi ${message.role} · ${entry.kind}`, details: { content: message.content } });
    }
  }
  const streamingId = `pi-streaming-${connectionGeneration}`;
  if (view.streaming) {
    const { role, content, text } = view.streaming;
    addEvent({ id: streamingId, at, type: `Pi ${role} message · streaming`, details: { content }, ...(role === "assistant" ? { preview: text || "Waiting for the first response token…" } : {}) });
    if (role === "assistant") showLiveResponse(text);
  } else if (eventRows.has(streamingId)) {
    addEvent({ id: streamingId, at, type: "Pi assistant message · saved to transcript", details: {}, preview: "" });
  }
  for (const [index, call] of (view.tools || []).entries()) {
    addEvent({ id: `pi-tool-${connectionGeneration}-${call.nested ? "nested-" : ""}${index}-${call.name}`, at, type: `Tool ${call.nested ? "(nested) " : ""}${call.name} · ${call.status}`, details: call.output ? { output: call.output.slice(-1000) } : {} });
  }
  if (view.retry) addEvent({ id: `pi-retry-${view.retry.at}`, at, type: "Pi model request · retry scheduled", level: "warn", details: { at: new Date(view.retry.at).toISOString(), error: view.retry.error } });
  if (view.runFailure) addEvent({ id: `pi-run-failure-${connectionGeneration}-${view.runFailure.reason}`, at, type: `Pi run ended unanswered · ${view.runFailure.reason}`, level: "warn", details: view.runFailure.detail ? { detail: view.runFailure.detail } : {} });
  addEvent({ id: `pi-view-${connectionGeneration}`, at, type: "Pi conversation view attached", details: { state: view.running ? `run in progress · ${view.turns ?? 0} tool round(s)` : "idle", inbox: (view.inbox || []).length } });
}

function setSocketState(state) { $("socket").textContent = `viewer: ${state}`; }
function activeRun() { return Boolean(agentId) && currentStatus === "running"; }

function updateControls() {
  const exists = Boolean(agentId), active = activeRun();
  $("launch").disabled = requestBusy || active;
  $("new-run").disabled = requestBusy || active;
  $("new-run").textContent = requestBusy ? "Starting…" : "New agent · fresh conversation";
  $("disconnect").disabled = !exists || !socket || socket.readyState !== WebSocket.OPEN;
  $("resume-run").disabled = requestBusy || !exists || Boolean(socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState));
  for (const id of ["arm-timeout", "timeout", "crash"]) $(id).disabled = !active;
}

function setStatus(status) {
  currentStatus = status?.status || "unknown";
  const dot = $("status").querySelector(".dot"), label = $("status").lastElementChild;
  dot.className = `dot ${currentStatus}`;
  if (label.textContent !== currentStatus) label.textContent = currentStatus;
  const errorTitle = status?.lastError || "";
  if (label.title !== errorTitle) label.title = errorTitle;
  if (status?.operationId && $("agent-id").dataset.runKey !== `${agentId}:${status.operationId}`) {
    const id = document.createElement("code"); id.textContent = agentId;
    const operation = document.createElement("span"); operation.className = "detail"; operation.textContent = `operation ${status.operationId}`;
    const details = document.createElement("details"); details.className = "run-identifiers";
    const summary = document.createElement("summary"); summary.textContent = "Run identifiers";
    details.append(summary, id, operation); $("agent-id").replaceChildren(details);
    $("agent-id").dataset.runKey = `${agentId}:${status.operationId}`;
  }
  if (status?.lastResponse && $("answer").textContent !== status.lastResponse) {
    $("answer-title").textContent = "Run result";
    $("answer").textContent = status.lastResponse;
  }
  else if (status?.lastError) {
    $("answer-title").textContent = "Run result";
    const explanation = status.lastError === "model_error"
      ? "The model request failed (model_error). Check the run trace and Wrangler output for any underlying provider details."
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
  const inspectionErrors = $("inspection-errors"); inspectionErrors.replaceChildren();
  for (const message of data.hands?.inspectionErrors || []) {
    const row = document.createElement("div"); row.className = "event warn"; row.textContent = `Inspection data unavailable: ${message}`; inspectionErrors.append(row);
  }
  if (brain.model) $("model-name").textContent = `${brain.model.provider}/${brain.model.modelId}`;
  addStateCard(summary, "Model", brain.model?.modelId || "not selected");
  addStateCard(summary, "Sessions", `${(brain.sessions || []).length}${(brain.sessions || []).some((s) => s.busy) ? " · active" : ""}`);
  addStateCard(summary, "Queued", String((brain.pending || []).length));
  addStateCard(summary, "Generation", brain.live?.generation ? "working" : "idle");
  const extra = $("brain-extra"); extra.replaceChildren();
  addStateCard(extra, "Provider", brain.model?.provider || "none");
  addStateCard(extra, "Thinking", brain.thinkingLevel || "default");
  addStateCard(extra, "Session detail", (brain.sessions || []).map((s) => `${s.id}${s.parent ? ` · child of ${s.parent}` : " · root"}${s.busy ? " · busy" : ""}`).join("\n") || "none");
  addStateCard(extra, "Compaction", (brain.live?.compactions || []).map((item) => `${item.trigger}${item.blocking ? " · blocking" : ""} · attempt ${item.attempt}`).join(", ") || (brain.live?.compactionFailure ? `last failed: ${brain.live.compactionFailure.error}` : "none active"));
  addStateCard(extra, "Pending submissions", (brain.pending || []).map((p) => `${p.status} · ${p.operationId}`).join("\n") || "none");
  addStateCard(extra, "Extensions", Array.isArray(brain.extensions) ? (brain.extensions.join(", ") || "host defaults") : JSON.stringify(brain.extensions));
  addStateCard(extra, "Usage", JSON.stringify(brain.usage || {}));
  const generation = brain.live?.generation;
  addStateCard(extra, "Generation", generation ? `attempt ${generation.attempt}${generation.retry ? ` · retry ${generation.retry.at}` : ""}${generation.deferred ? ` · deferred until ${generation.deferred.pollAt}` : ""}` : "idle");
  addStateCard(extra, "Run", brain.live?.run ? `${brain.live.run.turns} tool round(s)` : brain.live?.runFailure ? `last run unanswered · ${brain.live.runFailure.reason}${brain.live.runFailure.detail ? ` · ${brain.live.runFailure.detail}` : ""}` : "idle");
  addStateCard(extra, "Inbox", (brain.live?.inbox || []).length ? `${brain.live.inbox.length} queued item(s)` : "empty");
  $("instructions").textContent = brain.instructions || "No base instructions are configured.";
  const tasks = $("durable-tasks"); tasks.replaceChildren();
  const liveTasks = brain.tasks || [];
  $("task-count").textContent = String(liveTasks.length);
  $("task-group").hidden = liveTasks.length === 0;
  if (liveTasks.length && Number($("task-group").dataset.count || 0) === 0) $("task-group").open = true;
  $("task-group").dataset.count = String(liveTasks.length);
  for (const task of liveTasks) {
    const row = document.createElement("div"); row.className = "list-row";
    const title = document.createElement("strong"); title.textContent = `${task.kind} · ${task.status}`;
    const detail = document.createElement("span"); detail.className = "detail"; detail.textContent = `task ${task.id} · conversation ${task.conversationId}${task.owner ? ` · owner task ${task.owner}` : ""}${task.background ? " · background" : ""}${task.abortRequested ? " · abort requested" : ""}`;
    row.append(title, detail); tasks.append(row);
  }
  if (!tasks.childElementCount) tasks.innerHTML = '<div class="empty">No live durable tasks. Settled work remains in the transcript.</div>';
  const transcript = $("transcript"); transcript.replaceChildren();
  const messages = (brain.transcript || []).flatMap((entry) => (entry.messages || []).map((message) => ({ entry, message })));
  $("transcript-count").textContent = messages.length > 30 ? `30 / ${messages.length}` : String(messages.length);
  if (!messages.length) transcript.innerHTML = '<div class="empty">No transcript entries yet.</div>';
  for (const { entry, message } of messages.slice(-30)) {
    const row = document.createElement("div"); row.className = "list-row";
    const title = document.createElement("strong"); title.textContent = `${message.role} · ${entry.kind}`;
    const text = document.createElement("pre"); text.textContent = message.content || "(no display text)";
    row.append(title, text); transcript.append(row);
  }
  const tools = $("tools"); tools.replaceChildren();
  const loadedTools = data.hands?.loadedTools || [], nestedTools = data.hands?.nestedTools || [];
  $("tool-count").textContent = String(loadedTools.length + nestedTools.length);
  for (const item of loadedTools) {
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
  for (const item of nestedTools) {
    const row = document.createElement("div"); row.className = "list-row";
    const title = document.createElement("strong"); title.textContent = `${item.group}.${item.name}`;
    const description = document.createElement("span"); description.className = "detail"; description.textContent = item.description;
    row.append(title, description); nested.append(row);
  }
  if (!nested.childElementCount) nested.innerHTML = '<div class="empty">No nested tools are available.</div>';
  const recent = $("recent-tools"); recent.replaceChildren();
  for (const item of data.hands?.recentTools || []) {
    const row = document.createElement("div"); row.className = "list-row";
    const title = document.createElement("strong"); title.textContent = `${item.name}${item.isError ? " · error" : ""}`;
    row.append(title);
    if (item.arguments) { const args = document.createElement("pre"); args.textContent = item.arguments; row.append(args); }
    if (item.result) { const result = document.createElement("pre"); result.textContent = item.result; row.append(result); }
    recent.append(row);
  }
  if (!recent.childElementCount) recent.innerHTML = '<div class="empty">No completed tool calls in the saved transcript yet.</div>';
  $("recent-tools-count").textContent = String((data.hands?.recentTools || []).length);
  const files = $("workspace-files"); files.replaceChildren();
  for (const item of data.hands?.workspaceFiles || []) {
    const row = document.createElement("div"); row.className = "list-row";
    const title = document.createElement("strong"); title.textContent = item.path;
    const kind = document.createElement("span"); kind.className = "pill"; kind.textContent = item.type;
    row.append(title, kind); files.append(row);
  }
  if (!files.childElementCount) files.innerHTML = '<div class="empty">The durable workspace is empty.</div>';
  $("workspace-count").textContent = String((data.hands?.workspaceFiles || []).length);
  const repos = $("artifact-repos"); repos.replaceChildren();
  for (const item of data.hands?.artifactRepos || []) {
    const row = document.createElement("div"); row.className = "list-row";
    const title = document.createElement("strong"); title.textContent = item.name;
    const detail = document.createElement("span"); detail.className = "detail"; detail.textContent = item.description || "session-scoped Artifacts repository";
    row.append(title, detail); repos.append(row);
  }
  if (!repos.childElementCount) repos.innerHTML = '<div class="empty">No Artifacts repositories are attached to this agent.</div>';
  const mcp = $("mcp-servers"); mcp.replaceChildren();
  for (const item of data.hands?.mcpServers || []) {
    const row = document.createElement("div"); row.className = "list-row";
    const title = document.createElement("strong"); title.textContent = item.name;
    const endpoint = document.createElement("span"); endpoint.className = "detail"; endpoint.textContent = item.endpoint;
    const state = document.createElement("span"); state.className = "pill"; state.textContent = "configured · live connection not inferred";
    row.append(title, endpoint, state); mcp.append(row);
  }
  if (!mcp.childElementCount) mcp.innerHTML = '<div class="empty">No MCP servers are configured on this agent.</div>';
  const browser = data.hands?.browser || {}, browserState = $("browser-state"); browserState.replaceChildren();
  addStateCard(browserState, "Browser", `${browser.name || "browser"} · persistent across turns; each conversation has its own tab`);
  const browserRuns = $("browser-runs"); browserRuns.replaceChildren();
  for (const item of browser.recentCalls || []) {
    const row = document.createElement("div"); row.className = "list-row";
    const title = document.createElement("strong"); title.textContent = item.isError ? "browser · error" : "browser"; row.append(title);
    if (item.arguments) { const code = document.createElement("pre"); code.textContent = item.arguments; row.append(code); }
    if (item.result) { const result = document.createElement("pre"); result.textContent = item.result; row.append(result); }
    browserRuns.append(row);
  }
  if (!browserRuns.childElementCount) browserRuns.innerHTML = '<div class="empty">No browser tool calls in the saved transcript yet.</div>';
  const sandbox = data.hands?.sandbox || {};
  const sandboxState = $("sandbox-state"); sandboxState.replaceChildren();
  addStateCard(sandboxState, "Container", sandbox.containerRunning ? "running" : "stopped");
  addStateCard(sandboxState, "Saved container snapshot", sandbox.snapshotAvailable ? `${sandbox.snapshotName || "available"}${sandbox.snapshotSize ? ` · ${sandbox.snapshotSize} bytes` : ""} · restored when the sandbox starts` : "none yet · saved after a shell tool returns");
  const calls = $("calls"); calls.replaceChildren();
  for (const call of data.hands?.currentCalls || []) {
    const row = document.createElement("div"); row.className = "list-row";
    const title = document.createElement("strong"); title.textContent = `${call.nested ? "nested · " : ""}${call.name} · ${call.status}`; row.append(title);
    if (call.output) { const output = document.createElement("pre"); output.textContent = call.output; row.append(output); }
    if (call.diagnostics?.length) { const diagnostics = document.createElement("pre"); diagnostics.textContent = JSON.stringify(call.diagnostics, null, 2); row.append(diagnostics); }
    calls.append(row);
  }
  if (!calls.childElementCount) calls.innerHTML = '<div class="empty">No active tool calls.</div>';
  $("calls-count").textContent = String((data.hands?.currentCalls || []).length);
  const activeCallCount = (data.hands?.currentCalls || []).length;
  const callsGroup = $("calls-count").closest("details");
  if (activeCallCount && Number(callsGroup.dataset.count || 0) === 0) callsGroup.open = true;
  callsGroup.dataset.count = String(activeCallCount);
  const hands = $("hands-summary"); hands.replaceChildren();
  addStateCard(hands, "Files", String((data.hands?.workspaceFiles || []).length));
  addStateCard(hands, "Tools", String(loadedTools.length + nestedTools.length));
  addStateCard(hands, "Active calls", String((data.hands?.currentCalls || []).length));
  addStateCard(hands, "Browser calls", String((browser.recentCalls || []).length));
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
    setSocketState("live · Pi trajectory and runtime events"); startPolling(generation); updateControls();
  };
  nextSocket.onmessage = (message) => {
    if (socket !== nextSocket) return;
    try {
      const event = JSON.parse(message.data);
      if (event?.type === "pi.view") renderPiView(event.view);
      else addEvent(event);
    } catch { showError("demo.socket.invalid_event", "Received an event that could not be read."); }
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
    agentId = result.agentId; currentStatus = "running"; localStorage.setItem(agentStorageKey, agentId); eventRows.clear(); eventsEl.replaceChildren(); filterEvents();
    $("answer").textContent = "Waiting for a run to finish.";
    const code = document.createElement("code"); code.textContent = agentId; $("agent-id").replaceChildren(code);
    setStatus({ status: "running", operationId: result.operationId }); connect();
  } catch (error) { showError("demo.launch.failed", error.message); }
  finally { requestBusy = false; $("launch").textContent = "Launch durable run"; updateControls(); }
}

async function resumeRun() {
  if (!agentId || requestBusy) return;
  requestBusy = true; $("resume-run").textContent = "Resuming…"; updateControls();
  try {
    await requestJson(`/agents/${agentId}/resume`, { method: "POST" });
    connect();
  } catch (error) {
    showError("demo.resume.failed", error.message);
  } finally {
    requestBusy = false; $("resume-run").textContent = "Resume run"; updateControls();
  }
}

async function interrupt(cause) {
  if (!agentId || !activeRun()) return;
  try {
    const result = await requestJson(`/agents/${agentId}/interrupt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cause }) });
    if (!result.interrupted) addEvent({ id: crypto.randomUUID(), at: new Date().toISOString(), type: "demo.interrupt.no_active_run", level: "warn", details: { cause } });
    if (cause === "runtime-crash" && result.interrupted) connect();
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
$("resume-run").addEventListener("click", resumeRun);
$("disconnect").addEventListener("click", () => socket?.close(1000, "Demo viewer disconnected"));
$("timeout").addEventListener("click", () => interrupt("deadline"));
$("arm-timeout").addEventListener("click", armDeadline);
$("crash").addEventListener("click", () => interrupt("runtime-crash"));
$("event-search").addEventListener("input", filterEvents);
$("event-level").addEventListener("change", filterEvents);
$("reset-event-filters").addEventListener("click", () => { $("event-search").value = ""; $("event-level").value = ""; filterEvents(); $("event-search").focus(); });
$("clear-view").addEventListener("click", () => { eventRows.clear(); eventsEl.innerHTML = '<div class="empty">Visible rows cleared. Reconnect to replay the Durable Object event history.</div>'; filterEvents(); });
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
filterEvents();
