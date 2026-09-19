const state = {
  data: null,
  filter: "all",
  query: "",
  events: [],
  pipeline: {},
};

const stages = ["collect", "normalize", "jev", "policy", "actions", "briefing"];
const sourceMeta = {
  email: { label: "Inbox", icon: "@", className: "email" },
  moodle: { label: "Moodle", icon: "M", className: "moodle" },
  github: { label: "GitHub", icon: "⌘", className: "work" },
  calendar: { label: "Calendar", icon: "◷", className: "calendar" },
  downloads: { label: "Files", icon: "↓", className: "files" },
  news: { label: "Daily news", icon: "✦", className: "news" },
  edstem: { label: "EdStem", icon: "E", className: "edstem" },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;",
}[character]));

const formatTime = (value) => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-HK", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
};

const formatDate = (value) => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-HK", { day: "numeric", month: "short" }).format(new Date(value));
};

const relativeTime = (value) => {
  if (!value) return "—";
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 30_000) return "just now";
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return formatDate(value);
};

const source = (name) => sourceMeta[name] ?? { label: name, icon: "•", className: "other" };

const humanize = (value) => String(value ?? "").replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());

const decisionSummary = (decision) => {
  const output = decision.output ?? {};
  if (decision.decision === "requiresAction") return output.actionRequired ? `${output.urgency ?? "soon"} attention` : "no action detected";
  if (decision.decision === "importantEmail") return output.important ? `${output.category ?? "important"} · ${output.requiresReply ? "reply likely" : "no reply needed"}` : "low priority email";
  if (decision.decision === "detectDeadline") return output.hasDeadline ? "deadline detected" : "no deadline found";
  if (decision.decision === "shouldDownloadFile") return output.download ? `retain · ${output.fileType ?? "file"}` : "do not retain automatically";
  if (decision.decision === "shouldCreateCalendarEvent") return output.createEvent ? "calendar event suggested" : "no event suggested";
  if (decision.decision === "worthReading") return output.worthReading ? `worth reading · ${output.category ?? "article"}` : `skip for now · ${output.category ?? "article"}`;
  return "decision recorded";
};

const confidence = (decision) => Math.round((decision?.output?.confidence ?? 0) * 100);

const toast = (message, type = "") => {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  $("#toast-stack").append(element);
  window.setTimeout(() => element.remove(), 4200);
};

const pushActivity = (title, detail, tone = "neutral", at = new Date().toISOString()) => {
  state.events.unshift({ title, detail, tone, at });
  state.events = state.events.slice(0, 9);
  renderActivity();
};

const fetchState = async () => {
  const response = await fetch("/api/state", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not read local agent state.");
  state.data = await response.json();
  render();
};

const renderMetrics = () => {
  const metrics = state.data?.metrics ?? {};
  $("#metric-total").textContent = metrics.total ?? 0;
  $("#metric-email").textContent = metrics.emails ?? 0;
  $("#metric-moodle").textContent = metrics.moodle ?? 0;
  $("#metric-review").textContent = metrics.lowConfidence ?? 0;
  $("#metric-unread").textContent = metrics.unread ?? 0;
  $("#side-email-count").textContent = metrics.emails ?? 0;
  $("#side-moodle-count").textContent = metrics.moodle ?? 0;
  $("#side-work-count").textContent = metrics.work ?? 0;
  $("#side-news-count").textContent = metrics.news ?? 0;
  $("#side-edstem-count").textContent = metrics.edstem ?? 0;
  $("#everything-count").textContent = `${metrics.total ?? 0} SIGNALS`;
  $("#donut-total").textContent = metrics.total ?? 0;
};

const renderHeader = () => {
  const run = state.data?.run ?? { active: false };
  const label = run.active ? "PROCESSING" : run.error ? "NEEDS ATTENTION" : run.completedAt ? "LAST PULSE COMPLETE" : "STANDING BY";
  $("#pulse-label").textContent = label;
  $("#pipeline-status").textContent = run.active ? "RUNNING" : run.error ? "ERROR" : "IDLE";
  $("#pipeline-status").classList.toggle("is-running", run.active);
  $("#connection-label").textContent = "LIVE LINK";
  $("#status-caption").textContent = run.active
    ? "Jev is evaluating your latest signals. Watch the pipeline move in real time."
    : run.error
      ? `The last pulse stopped: ${run.error}`
      : state.data?.metrics?.total
        ? `${state.data.metrics.total} signals are in view. Review the calls that need your judgment.`
        : "Your sources are quiet. Run a pulse to bring the whole day into focus.";
  $("#pipeline-footnote").textContent = run.active
    ? `Live run ${run.runId?.slice(0, 8) ?? "—"} · ${humanize(run.stage ?? "collect")}`
    : run.completedAt
      ? `Last pulse ${relativeTime(run.completedAt)} · ${run.itemCount ?? 0} items · ${run.decisionCount ?? 0} Jev calls`
      : "Waiting for the next pulse";
  $("#run-button").disabled = run.active;
  $("#run-button").innerHTML = run.active ? '<span class="run-icon">◌</span><span>Pulse running</span>' : '<span class="run-icon">↻</span><span>Run pulse</span>';
};

const renderPipeline = () => {
  const run = state.data?.run ?? { active: false };
  const activeIndex = stages.indexOf(run.stage);
  $("#pipeline").innerHTML = stages.map((stage, index) => {
    const done = run.active ? index < activeIndex : Boolean(run.completedAt) && index <= activeIndex;
    const active = run.active && index === activeIndex;
    return `<div class="pipeline-node ${done ? "is-done" : ""} ${active ? "is-active" : ""}">
      <div class="pipeline-dot">${done ? "✓" : String(index + 1).padStart(2, "0")}</div>
      <span class="pipeline-label">${escapeHtml(stage === "jev" ? "JEV DECISIONS" : stage.toUpperCase())}</span>
    </div>`;
  }).join("");
};

const renderReviewQueue = () => {
  const queue = state.data?.lowConfidence ?? [];
  $("#queue-count").textContent = queue.length;
  if (queue.length === 0) {
    $("#review-list").innerHTML = '<div class="review-empty"><div><strong>Clear runway.</strong><p>No low-confidence decisions are waiting for you.</p></div></div>';
    return;
  }
  $("#review-list").innerHTML = queue.slice(0, 5).map((entry) => {
    const meta = source(entry.item.source);
    const percent = confidence(entry.decision);
    return `<article class="review-card">
      <div class="review-meta"><span>${escapeHtml(meta.label)} · ${escapeHtml(humanize(entry.decision.decision))}</span><span class="review-confidence">${percent}% confidence</span></div>
      <button class="review-title plain-button" data-open-item="${escapeHtml(entry.item.id)}" type="button">${escapeHtml(entry.item.title)}</button>
      <div class="review-reason">${escapeHtml(decisionSummary(entry.decision))} · Jev wants a human read.</div>
      <div class="review-actions"><button class="approve" data-review-item="${escapeHtml(entry.item.id)}" data-review-decision="${escapeHtml(entry.decision.decision)}" data-review-status="approved" type="button">Accept signal</button><button data-review-item="${escapeHtml(entry.item.id)}" data-review-decision="${escapeHtml(entry.decision.decision)}" data-review-status="dismissed" type="button">Dismiss</button></div>
    </article>`;
  }).join("");
};

const renderActivity = () => {
  const events = state.events.length > 0 ? state.events : [{ title: "Dashboard armed", detail: "Waiting for a pulse", tone: "neutral", at: new Date().toISOString() }];
  $("#activity-list").innerHTML = events.map((event) => `<div class="activity-row"><span class="activity-pip ${escapeHtml(event.tone)}"></span><div><div class="activity-title">${escapeHtml(event.title)}</div><div class="activity-detail">${escapeHtml(event.detail)}</div></div><span class="activity-time">${escapeHtml(relativeTime(event.at))}</span></div>`).join("");
};

const renderDeadlines = () => {
  const deadlines = (state.data?.deadlines ?? []).slice().sort((left, right) => new Date(left.deadline) - new Date(right.deadline)).slice(0, 4);
  if (deadlines.length === 0) {
    $("#deadline-list").innerHTML = '<div class="empty-state"><div><strong>No near deadlines.</strong><p>The next seven days are clear in your local state.</p></div></div>';
    return;
  }
  $("#deadline-list").innerHTML = deadlines.map((deadline) => {
    const date = new Date(deadline.deadline);
    return `<div class="deadline-row"><div class="deadline-date"><span>${escapeHtml(new Intl.DateTimeFormat("en-HK", { day: "2-digit" }).format(date))}</span><span>${escapeHtml(new Intl.DateTimeFormat("en-HK", { month: "short" }).format(date))}</span></div><div><div class="deadline-title">${escapeHtml(deadline.title)}</div><div class="deadline-source">${escapeHtml(source(deadline.source).label)}</div></div><span class="deadline-when">${escapeHtml(formatTime(deadline.deadline))}</span></div>`;
  }).join("");
};

const renderSourceVisual = () => {
  const counts = state.data?.sources ?? {};
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const colors = ["var(--cyan)", "var(--lime)", "var(--violet)", "var(--coral)", "var(--gold)"];
  let cursor = 0;
  const segments = Object.entries(counts).map(([name, count], index) => {
    const start = total === 0 ? 0 : cursor / total * 100;
    cursor += count;
    const end = total === 0 ? 0 : cursor / total * 100;
    return `${colors[index % colors.length]} ${start}% ${end}%`;
  });
  $("#source-donut").style.background = total === 0 ? "conic-gradient(rgba(255,255,255,.08) 0 100%)" : `conic-gradient(${segments.join(", ")})`;
  const labels = ["email", "github", "moodle", "calendar", "downloads", "news", "edstem"];
  $("#source-bars").innerHTML = labels.map((name) => {
    const count = counts[name] ?? 0;
    const width = total === 0 ? 0 : Math.max(4, count / total * 100);
    return `<div class="source-bar-row"><span>${escapeHtml(source(name).label)}</span><div class="source-bar-track"><div class="source-bar-fill" style="width:${width}%"></div></div><b>${count}</b></div>`;
  }).join("");
};

const renderFocus = () => {
  const metrics = state.data?.metrics ?? {};
  const total = metrics.total ?? 0;
  const weighted = total === 0 ? 0 : Math.min(100, Math.round(((metrics.unread ?? 0) + (metrics.deadlines ?? 0) * 1.6 + (metrics.lowConfidence ?? 0) * 2) / Math.max(1, total) * 100));
  $("#focus-score").textContent = `${weighted}%`;
  $("#focus-meter-fill").style.width = `${weighted}%`;
  $("#focus-breakdown").innerHTML = [
    ["Unread mail", metrics.unread ?? 0],
    ["Deadlines, 7 days", metrics.deadlines ?? 0],
    ["Human review", metrics.lowConfidence ?? 0],
  ].map(([label, count]) => `<div class="focus-line"><span>${escapeHtml(label)}</span><strong>${count}</strong></div>`).join("");
};

const filteredItems = () => {
  const items = state.data?.items ?? [];
  return items.filter((item) => {
    const matchesFilter = state.filter === "all"
      || (state.filter === "work" && ["github", "calendar"].includes(item.source))
      || (state.filter === "moodle" && item.source === "moodle")
      || (state.filter === "email" && item.source === "email")
      || (state.filter === "news" && item.source === "news")
      || (state.filter === "edstem" && item.source === "edstem");
    const haystack = `${item.title} ${item.content ?? ""} ${item.source}`.toLowerCase();
    return matchesFilter && haystack.includes(state.query.toLowerCase());
  });
};

const renderStream = () => {
  const items = filteredItems();
  const decisions = state.data?.decisions ?? [];
  if (items.length === 0) {
    $("#stream-table").innerHTML = '<div class="empty-state"><div><strong>No signals here yet.</strong><p>Run a pulse or loosen the filter to see more of your day.</p></div></div>';
    return;
  }
  $("#stream-table").innerHTML = items.slice(0, 100).map((item) => {
    const meta = source(item.source);
    const itemDecisions = decisions.filter((decision) => decision.itemId === item.id);
    const weakest = itemDecisions.slice().sort((left, right) => confidence(left) - confidence(right))[0];
    const hot = weakest && confidence(weakest) < 75;
    return `<button class="stream-row" data-open-item="${escapeHtml(item.id)}" type="button"><span class="stream-signal"><span class="stream-icon ${escapeHtml(meta.className)}">${escapeHtml(meta.icon)}</span><span><span class="stream-title">${escapeHtml(item.title)}</span><span class="stream-subtitle">${escapeHtml((item.content ?? "").slice(0, 100))}</span></span></span><span class="stream-source">${escapeHtml(meta.label)}</span><span class="stream-when">${escapeHtml(relativeTime(item.createdAt ?? item.observedAt))}</span><span class="stream-state ${hot ? "is-hot" : ""}">${hot ? `${confidence(weakest)}% review` : "observed"}</span></button>`;
  }).join("");
};

const openItem = (itemId) => {
  const item = state.data?.items?.find((candidate) => candidate.id === itemId);
  if (!item) return;
  const meta = source(item.source);
  const decisions = (state.data?.decisions ?? []).filter((decision) => decision.itemId === item.id);
  const url = item.url && /^https?:\/\//i.test(item.url) ? `<a class="detail-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Open source ↗</a>` : "";
  $("#detail-content").innerHTML = `<div class="dialog-close"><button id="close-detail" type="button" aria-label="Close detail">×</button></div><div class="detail-source"><span class="stream-icon ${escapeHtml(meta.className)}">${escapeHtml(meta.icon)}</span>${escapeHtml(meta.label)} · ${escapeHtml(formatDate(item.createdAt ?? item.observedAt))}</div><h2>${escapeHtml(item.title)}</h2><div class="detail-content">${escapeHtml(item.content ?? "No content excerpt stored for this signal.")}</div>${url}<div class="detail-section"><h3>Jev decisions</h3><div class="decision-stack">${decisions.length === 0 ? '<div class="detail-content">No decision was needed for this signal.</div>' : decisions.map((decision) => `<div class="decision-row"><div><div class="decision-name">${escapeHtml(humanize(decision.decision))}</div><div class="decision-answer">${escapeHtml(decisionSummary(decision))}</div></div><div><div class="decision-meter"><span style="width:${confidence(decision)}%"></span></div><div class="decision-percent">${confidence(decision)}%</div></div></div>`).join("")}</div></div>`;
  $("#detail-dialog").showModal();
  $("#close-detail").addEventListener("click", () => $("#detail-dialog").close(), { once: true });
};

const render = () => {
  renderMetrics();
  renderHeader();
  renderPipeline();
  renderReviewQueue();
  renderActivity();
  renderDeadlines();
  renderSourceVisual();
  renderFocus();
  renderStream();
};

const handleEvent = (event) => {
  let payload;
  try { payload = JSON.parse(event.data); } catch { return; }
  if (payload.type === "run_started") {
    state.pipeline = {};
    pushActivity("Pulse started", "Opening the local source graph", "cyan", payload.at);
  } else if (payload.type === "stage") {
    state.pipeline[payload.stage] = payload.status;
    pushActivity(`${payload.label} ${payload.status === "started" ? "started" : "complete"}`, payload.status === "started" ? "Jev pipeline is moving" : "Signal passed to the next layer", payload.status === "started" ? "lime" : "cyan", payload.at);
  } else if (payload.type === "items_collected") {
    pushActivity("Signals collected", `${payload.count} items entered the local graph`, "cyan", payload.at);
  } else if (payload.type === "decisions_completed") {
    pushActivity("Jev finished", `${payload.count} typed decisions recorded`, "lime", payload.at);
  } else if (payload.type === "actions_completed") {
    pushActivity("Policy checked", `${payload.count} action paths inspected`, "gold", payload.at);
  } else if (payload.type === "run_completed") {
    pushActivity("Pulse complete", `${payload.itemCount} items · ${payload.decisionCount} decisions`, "lime", payload.at);
    fetchState().catch(() => {});
  } else if (payload.type === "run_failed") {
    pushActivity("Pulse stopped", payload.error, "coral", payload.at);
    toast(payload.error, "error");
    fetchState().catch(() => {});
  } else if (payload.type === "state_invalidated") {
    fetchState().catch(() => {});
  }
  renderHeader();
  renderPipeline();
};

const runPulse = async (mock = false) => {
  try {
    const response = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mock }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Could not start pulse.");
    toast(mock ? "Demo pulse started." : "Live pulse started.", "success");
  } catch (error) {
    toast(error.message, "error");
  }
};

const resolveReview = async (button) => {
  button.disabled = true;
  try {
    const response = await fetch("/api/reviews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemId: button.dataset.reviewItem, decision: button.dataset.reviewDecision, status: button.dataset.reviewStatus }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Could not save review.");
    toast(button.dataset.reviewStatus === "approved" ? "Signal accepted and marked reviewed." : "Signal dismissed from the queue.", "success");
    await fetchState();
  } catch (error) {
    button.disabled = false;
    toast(error.message, "error");
  }
};

const selectView = (view) => {
  const control = view === "control";
  $("#control-view").classList.toggle("is-hidden", !control);
  $("#everything-view").classList.toggle("is-hidden", control);
  $$(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  $("#crumb-view").textContent = control ? "CONTROL ROOM" : "EVERYTHING";
};

$$('[data-view]').forEach((button) => button.addEventListener("click", () => selectView(button.dataset.view)));
$("#run-button").addEventListener("click", () => runPulse(false));
$("#search-input").addEventListener("input", (event) => { state.query = event.target.value; renderStream(); });
$$('[data-filter]').forEach((button) => button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  $$('[data-filter]').forEach((candidate) => candidate.classList.toggle("is-active", candidate === button));
  renderStream();
}));
document.addEventListener("click", (event) => {
  const reviewButton = event.target.closest("[data-review-item]");
  if (reviewButton) { resolveReview(reviewButton); return; }
  const itemButton = event.target.closest("[data-open-item]");
  if (itemButton) openItem(itemButton.dataset.openItem);
});
$("#detail-dialog").addEventListener("click", (event) => { if (event.target === $("#detail-dialog")) $("#detail-dialog").close(); });
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "1") { event.preventDefault(); selectView("control"); }
  if ((event.metaKey || event.ctrlKey) && event.key === "2") { event.preventDefault(); selectView("everything"); }
});

const connectEvents = () => {
  const stream = new EventSource("/api/events");
  stream.onopen = () => { $("#connection-label").textContent = "LIVE LINK"; };
  stream.onerror = () => { $("#connection-label").textContent = "RECONNECTING"; };
  ["run_started", "stage", "items_collected", "decisions_completed", "actions_completed", "run_completed", "run_failed", "state_invalidated"].forEach((name) => stream.addEventListener(name, handleEvent));
};

const tickClock = () => {
  const now = new Date();
  $("#current-day").textContent = new Intl.DateTimeFormat("en-HK", { weekday: "long", day: "numeric", month: "long" }).format(now).toUpperCase();
  $("#current-time").textContent = new Intl.DateTimeFormat("en-HK", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(now);
};

tickClock();
window.setInterval(tickClock, 1_000);
connectEvents();
fetchState().catch((error) => toast(error.message, "error"));
window.setInterval(() => fetchState().catch(() => {}), 10_000);
