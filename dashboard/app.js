const validFilters = new Set(["all", "deadlines", "email", "work", "moodle", "news", "edstem", "files"]);
const persistedFilter = window.localStorage.getItem("morning-agent:filter");
const persistedCourse = window.localStorage.getItem("morning-agent:course") ?? "";

const state = {
  data: null,
  filter: validFilters.has(persistedFilter) ? persistedFilter : "all",
  course: persistedCourse,
  query: "",
  streamLimit: 50,
  view: window.localStorage.getItem("morning-agent:view") === "everything" ? "everything" : "control",
  events: [],
  pipeline: {},
  liveRunId: "",
  liveRunActive: false,
  liveStage: "",
  liveLastEventAt: "",
};

let connectionStatus = "connecting";
let lastFocusedElement = null;

const stages = ["collect", "normalize", "jev", "policy", "actions", "briefing"];
const sourceMeta = {
  email: { label: "Inbox", icon: "@", className: "email" },
  moodle: { label: "Moodle", icon: "M", className: "moodle" },
  github: { label: "GitHub", icon: "⌘", className: "work" },
  calendar: { label: "Calendar", icon: "◷", className: "calendar" },
  downloads: { label: "Files", icon: "↓", className: "files" },
  news: { label: "Daily news", icon: "✦", className: "news" },
  edstem: { label: "Ed Lessons", icon: "E", className: "edstem" },
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
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-HK", { hour: "2-digit", minute: "2-digit" }).format(date)
    : "—";
};

const formatDate = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-HK", { day: "numeric", month: "short" }).format(date)
    : "—";
};

const relativeTime = (value) => {
  if (!value) return "—";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const delta = Date.now() - timestamp;
  if (delta < 30_000) return "just now";
  if (delta < 0) return "upcoming";
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return formatDate(value);
};

const source = (name) => sourceMeta[name] ?? { label: name, icon: "•", className: "other" };

const greeting = (hour) => hour < 12 ? "Good morning," : hour < 18 ? "Good afternoon," : "Good evening,";

const effectiveRun = () => {
  const run = state.data?.run ?? { active: false };
  if (!state.liveRunActive) return run;
  return {
    ...run,
    active: true,
    runId: state.liveRunId || run.runId,
    stage: state.liveStage || run.stage,
    lastEventAt: state.liveLastEventAt || run.lastEventAt,
  };
};

const reconcileLiveRun = () => {
  const serverRun = state.data?.run;
  if (!state.liveRunActive || !serverRun || !serverRun.runId || serverRun.runId !== state.liveRunId) return;
  if (!serverRun.active) {
    state.liveRunActive = false;
    state.liveStage = "";
    state.pipeline = {};
    return;
  }
  if (serverRun.stage) {
    const activeIndex = stages.indexOf(serverRun.stage);
    for (let index = 0; index < activeIndex; index += 1) state.pipeline[stages[index]] = "completed";
    state.pipeline[serverRun.stage] ??= "started";
    state.liveStage = serverRun.stage;
  }
};

const courseInfo = (item) => {
  const metadata = item?.metadata ?? {};
  if (typeof metadata.course === "string" && metadata.course.trim().length > 0) {
    const label = metadata.course.trim();
    return { key: `course:${label.toLowerCase()}`, label };
  }
  if (typeof metadata.courseId === "string" && metadata.courseId.trim().length > 0) {
    const courseId = metadata.courseId.trim();
    const courseLabel = typeof metadata.courseLabel === "string" && metadata.courseLabel.trim().length > 0
      ? metadata.courseLabel.trim()
      : item.source === "edstem" ? `Ed ${courseId}` : `Course ${courseId}`;
    return { key: `course-id:${item.source}:${courseId.toLowerCase()}`, label: courseLabel };
  }
  return null;
};

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

const errorMessage = (error, fallback) => error instanceof Error ? error.message : typeof error === "string" ? error : fallback;

const toast = (message, type = "") => {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  $("#toast-stack").append(element);
  window.setTimeout(() => element.remove(), 4200);
};

const setConnectionStatus = (status) => {
  connectionStatus = status;
  const label = $("#connection-label");
  if (label) label.textContent = status === "live" ? "Connected" : status === "reconnecting" ? "Reconnecting" : "Connecting";
  const connectionState = $(".connection-state");
  connectionState?.classList.toggle("is-live", status === "live");
  connectionState?.classList.toggle("is-reconnecting", status === "reconnecting");
  if (state.data !== null) renderHeader();
};

const pushActivity = (title, detail, tone = "neutral", at = new Date().toISOString()) => {
  state.events.unshift({ title, detail, tone, at });
  state.events = state.events.slice(0, 9);
  renderActivity();
};

const fetchState = async () => {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not read local agent state.");
    state.data = await response.json();
    setConnectionStatus("live");
    reconcileLiveRun();
    render();
  } catch (error) {
    setConnectionStatus("reconnecting");
    if (state.data === null) toast(errorMessage(error, "Could not read local agent state."), "error");
    throw error;
  }
};

const renderMetrics = () => {
  const metrics = state.data?.metrics ?? {};
  $("#metric-total").textContent = metrics.total ?? 0;
  $("#metric-email").textContent = metrics.emails ?? 0;
  $("#metric-moodle").textContent = (metrics.moodle ?? 0) + (metrics.edstem ?? 0);
  $("#metric-review").textContent = metrics.lowConfidence ?? 0;
  $("#metric-unread").textContent = metrics.unread ?? 0;
  $("#side-email-count").textContent = metrics.emails ?? 0;
  $("#side-moodle-count").textContent = metrics.moodle ?? 0;
  $("#side-work-count").textContent = metrics.work ?? 0;
  $("#side-news-count").textContent = metrics.news ?? 0;
  $("#side-edstem-count").textContent = metrics.edstem ?? 0;
  $("#side-downloads-count").textContent = metrics.downloads ?? 0;
  $("#everything-count").textContent = `${metrics.total ?? 0} items`;
  $("#donut-total").textContent = metrics.total ?? 0;
  const courses = new Set((state.data?.items ?? []).map(courseInfo).filter(Boolean).map((course) => course.key));
  $("#metric-course-count").textContent = `${courses.size} course${courses.size === 1 ? "" : "s"}`;
};

const renderHeader = () => {
  const run = effectiveRun();
  const label = run.active ? "Processing" : run.error ? "Needs attention" : run.completedAt ? "Last run complete" : "Ready";
  $("#pulse-label").textContent = label;
  $("#pipeline-status").textContent = run.active ? "Running" : run.error ? "Error" : "Idle";
  $("#pipeline-status").classList.toggle("is-running", run.active);
  $("#status-caption").textContent = run.active
    ? "Checking your latest sources."
    : run.error
      ? `The last run stopped: ${run.error}`
      : state.data?.metrics?.total
        ? `${state.data.metrics.total} items are in view. Check anything that needs your attention.`
        : "Nothing has been collected yet. Run the first check when you are ready.";
  $("#pipeline-footnote").textContent = run.active
    ? `Run ${run.runId?.slice(0, 8) ?? "—"} · ${humanize(run.stage ?? "collect")}`
    : run.completedAt
      ? `Last run ${relativeTime(run.completedAt)} · ${run.itemCount ?? 0} items · ${run.decisionCount ?? 0} decisions`
      : state.data?.metrics?.total
        ? `${state.data.metrics.total} stored items · ready for another run`
        : "Waiting for the first run";
  $("#activity-status").textContent = run.active ? "updating" : connectionStatus === "live" ? "local state" : "offline";
  const button = $("#run-button");
  button.disabled = run.active;
  button.classList.toggle("is-loading", run.active);
  button.innerHTML = run.active
    ? '<span class="run-icon">◌</span><span>Run in progress</span>'
    : `<span class="run-icon">↻</span><span>${run.error ? "Retry run" : "Run now"}</span>`;
};

const renderPipeline = () => {
  const run = effectiveRun();
  const activeIndex = stages.indexOf(run.stage);
  const livePipeline = state.liveRunActive && Boolean(state.liveRunId);
  $("#pipeline").innerHTML = stages.map((stage, index) => {
    const liveStatus = state.pipeline[stage];
    const done = livePipeline
      ? liveStatus === "completed"
      : run.active ? index < activeIndex : Boolean(run.completedAt) && index <= activeIndex;
    const active = livePipeline ? liveStatus === "started" : run.active && index === activeIndex;
    return `<div class="pipeline-node ${done ? "is-done" : ""} ${active ? "is-active" : ""}">
      <div class="pipeline-dot">${done ? "✓" : String(index + 1).padStart(2, "0")}</div>
      <span class="pipeline-label">${escapeHtml(stage === "jev" ? "Jev decisions" : humanize(stage))}</span>
    </div>`;
  }).join("");
};

const renderReviewQueue = () => {
  const queue = state.data?.lowConfidence ?? [];
  $("#queue-count").textContent = queue.length;
  $("#queue-count").setAttribute("aria-label", `${queue.length} item${queue.length === 1 ? "" : "s"} to review`);
  if (queue.length === 0) {
    $("#review-list").innerHTML = '<div class="review-empty"><div><strong>Nothing to review.</strong><p>No low-confidence decisions are waiting for you.</p></div></div>';
    return;
  }
  $("#review-list").innerHTML = queue.map((entry) => {
    const meta = source(entry.item.source);
    const percent = confidence(entry.decision);
    return `<article class="review-card">
      <div class="review-meta"><span>${escapeHtml(meta.label)} · ${escapeHtml(humanize(entry.decision.decision))}</span><span class="review-confidence">${percent}% confidence</span></div>
      <button class="review-title plain-button" data-open-item="${escapeHtml(entry.item.id)}" type="button">${escapeHtml(entry.item.title)}</button>
      <div class="review-reason">${escapeHtml(decisionSummary(entry.decision))} · Jev flagged this for a human check.</div>
      <div class="review-actions"><button class="approve" data-review-item="${escapeHtml(entry.item.id)}" data-review-decision="${escapeHtml(entry.decision.decision)}" data-review-status="approved" type="button">Mark reviewed</button><button data-review-item="${escapeHtml(entry.item.id)}" data-review-decision="${escapeHtml(entry.decision.decision)}" data-review-status="dismissed" type="button">Dismiss</button></div>
    </article>`;
  }).join("");
};

const renderActivity = () => {
  const run = effectiveRun();
  const fallback = run.error
    ? { title: "Last run stopped", detail: run.error, tone: "coral", at: run.lastEventAt ?? new Date().toISOString() }
    : run.active
    ? { title: "Run in progress", detail: `${humanize(run.stage ?? "collect")} stage is active`, tone: "lime", at: run.lastEventAt ?? new Date().toISOString() }
    : run.completedAt
        ? { title: "Last run complete", detail: `${run.itemCount ?? 0} items · ${run.decisionCount ?? 0} decisions`, tone: "lime", at: run.completedAt }
        : state.data?.metrics?.total
          ? { title: "Local state loaded", detail: `${state.data.metrics.total} items ready · run again for fresh data`, tone: "cyan", at: state.data.generatedAt ?? new Date().toISOString() }
          : { title: "Ready", detail: "Waiting for the first run", tone: "neutral", at: new Date().toISOString() };
  const events = state.events.length > 0 ? state.events : [fallback];
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
    return `<button class="deadline-row" data-open-item="${escapeHtml(deadline.id)}" type="button" aria-label="Open ${escapeHtml(deadline.title)}"><span class="deadline-date"><span>${escapeHtml(new Intl.DateTimeFormat("en-HK", { day: "2-digit" }).format(date))}</span><span>${escapeHtml(new Intl.DateTimeFormat("en-HK", { month: "short" }).format(date))}</span></span><span><span class="deadline-title">${escapeHtml(deadline.title)}</span><span class="deadline-source">${escapeHtml(source(deadline.source).label)}</span></span><span class="deadline-when">${escapeHtml(formatTime(deadline.deadline))}</span></button>`;
  }).join("");
};

const renderSourceVisual = () => {
  const counts = state.data?.sources ?? {};
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const sourceOrder = ["email", "github", "moodle", "calendar", "downloads", "news", "edstem"];
  const colors = {
    email: "var(--lime)",
    github: "var(--cyan)",
    moodle: "var(--violet)",
    calendar: "var(--cyan)",
    downloads: "var(--coral)",
    news: "var(--gold)",
    edstem: "var(--coral)",
  };
  let cursor = 0;
  const segments = sourceOrder.map((name) => {
    const count = counts[name] ?? 0;
    const start = total === 0 ? 0 : cursor / total * 100;
    cursor += count;
    const end = total === 0 ? 0 : cursor / total * 100;
    return `${colors[name]} ${start}% ${end}%`;
  });
  $("#source-donut").style.background = total === 0 ? "conic-gradient(rgba(255,255,255,.08) 0 100%)" : `conic-gradient(${segments.join(", ")})`;
  $("#source-bars").innerHTML = sourceOrder.map((name) => {
    const count = counts[name] ?? 0;
    const width = total === 0 || count === 0 ? 0 : Math.max(4, count / total * 100);
    return `<div class="source-bar-row"><span>${escapeHtml(source(name).label)}</span><div class="source-bar-track"><div class="source-bar-fill" style="--bar-color:${colors[name]};width:${width}%"></div></div><b>${count}</b></div>`;
  }).join("");
};

const renderFocus = () => {
  const metrics = state.data?.metrics ?? {};
  const total = metrics.total ?? 0;
  const weighted = total === 0 ? 0 : Math.min(100, Math.round(((metrics.unread ?? 0) + (metrics.deadlines ?? 0) * 1.6 + (metrics.lowConfidence ?? 0) * 2) / Math.max(1, total) * 100));
  $("#focus-score").textContent = `${weighted}%`;
  $("#focus-meter").setAttribute("aria-valuenow", String(weighted));
  $("#focus-meter").setAttribute("aria-valuetext", `${weighted}% attention load`);
  $("#focus-meter-fill").style.width = `${weighted}%`;
  $("#focus-breakdown").innerHTML = [
    ["Unread mail", metrics.unread ?? 0],
    ["Deadlines, 7 days", metrics.deadlines ?? 0],
    ["Human review", metrics.lowConfidence ?? 0],
  ].map(([label, count]) => `<div class="focus-line"><span>${escapeHtml(label)}</span><strong>${count}</strong></div>`).join("");
};

const renderCourseFilter = () => {
  const select = $("#course-filter");
  if (!select) return;
  const courses = new Map();
  for (const item of state.data?.items ?? []) {
    const course = courseInfo(item);
    if (course !== null) courses.set(course.key, course.label);
  }
  if (state.course !== "" && !courses.has(state.course)) {
    state.course = "";
    window.localStorage.removeItem("morning-agent:course");
  }
  select.replaceChildren(new Option("All courses", ""));
  for (const [key, label] of Array.from(courses.entries()).sort((left, right) => left[1].localeCompare(right[1]))) {
    select.append(new Option(label, key));
  }
  select.value = state.course;
};

const filteredItems = () => {
  const items = state.data?.items ?? [];
  return items.filter((item) => {
    const matchesFilter = state.filter === "all"
      || (state.filter === "work" && ["github", "calendar"].includes(item.source))
      || (state.filter === "deadlines" && item.deadline !== undefined)
      || (state.filter === "moodle" && item.source === "moodle")
      || (state.filter === "email" && item.source === "email")
      || (state.filter === "news" && item.source === "news")
      || (state.filter === "edstem" && item.source === "edstem")
      || (state.filter === "files" && item.source === "downloads");
    const itemCourse = courseInfo(item);
    const matchesCourse = state.course === "" || itemCourse?.key === state.course;
    const haystack = `${item.title} ${item.content ?? ""} ${item.source} ${itemCourse?.label ?? ""}`.toLowerCase();
    return matchesFilter && matchesCourse && haystack.includes(state.query.toLowerCase());
  });
};

const renderStream = () => {
  const items = filteredItems();
  const pendingReviewsByItem = new Map();
  for (const entry of state.data?.lowConfidence ?? []) {
    const pending = pendingReviewsByItem.get(entry.item.id) ?? [];
    pending.push(entry.decision);
    pendingReviewsByItem.set(entry.item.id, pending);
  }
  const visibleItems = items.slice(0, state.streamLimit);
  const filterSuffix = state.query || state.course ? " · filtered" : "";
  $("#stream-result-count").textContent = `${items.length} item${items.length === 1 ? "" : "s"}${filterSuffix}`;
  if (items.length === 0) {
    const clearAction = state.filter !== "all" || state.course !== "" || state.query !== ""
      ? '<button class="empty-action" data-clear-filters type="button">Clear filters</button>'
      : "";
    $("#stream-table").innerHTML = `<div class="empty-state"><div><strong>No items here yet.</strong><p>Run a check or loosen the filter to see more of your day.</p>${clearAction}</div></div>`;
    $("#stream-pagination").textContent = "Showing 0 items";
    $("#stream-more").hidden = true;
    return;
  }
  $("#stream-table").innerHTML = visibleItems.map((item) => {
    const meta = source(item.source);
    const pendingReviews = pendingReviewsByItem.get(item.id) ?? [];
    const weakest = pendingReviews.slice().sort((left, right) => confidence(left) - confidence(right))[0];
    const hot = weakest && confidence(weakest) < 75;
    const unread = item.metadata?.unread === true;
    const isDeadline = item.deadline !== undefined;
    const isLesson = item.source === "edstem" && item.metadata?.kind === "lesson";
    const itemCourse = courseInfo(item);
    const stateClass = hot ? "is-hot" : unread ? "is-unread" : isDeadline ? "is-deadline" : "";
    const stateText = hot ? `${confidence(weakest)}% review` : unread ? "unread" : isDeadline ? "deadline" : isLesson ? "lesson" : "observed";
    const subtitle = [itemCourse?.label, item.content ?? ""].filter(Boolean).join(" · ").slice(0, 120);
    return `<button class="stream-row" data-open-item="${escapeHtml(item.id)}" type="button" aria-label="Open ${escapeHtml(item.title)}"><span class="stream-signal"><span class="stream-icon ${escapeHtml(meta.className)}">${escapeHtml(meta.icon)}</span><span><span class="stream-title">${escapeHtml(item.title)}</span><span class="stream-subtitle">${escapeHtml(subtitle)}</span></span></span><span class="stream-source">${escapeHtml(meta.label)}</span><span class="stream-when">${escapeHtml(relativeTime(item.createdAt ?? item.observedAt))}</span><span class="stream-state ${stateClass}">${stateText}</span></button>`;
  }).join("");
  $("#stream-pagination").textContent = items.length > visibleItems.length
    ? `Showing ${visibleItems.length} of ${items.length} items`
    : `Showing all ${items.length} item${items.length === 1 ? "" : "s"}`;
  $("#stream-more").hidden = visibleItems.length >= items.length;
};

const safeHttpUrl = (value) => typeof value === "string" && /^https?:\/\//i.test(value) ? value : "";

const resourceMarkup = (item) => {
  const resources = Array.isArray(item.metadata?.resources) ? item.metadata.resources : [];
  const links = resources
    .filter((resource) => resource && safeHttpUrl(resource.url))
    .slice(0, 20)
    .map((resource) => `<a class="resource-link" href="${escapeHtml(resource.url)}" target="_blank" rel="noreferrer"><span>${escapeHtml(resource.title || "Resource")}</span><span>↗</span></a>`)
    .join("");
  return links.length === 0 ? "" : `<div class="detail-section resource-section"><h3>Lesson resources</h3><div class="resource-list">${links}</div></div>`;
};

const metadataMarkup = (item) => {
  const entries = Object.entries(item.metadata ?? {})
    .filter(([key, value]) => key !== "resources" && ["string", "number", "boolean"].includes(typeof value))
    .filter(([key]) => !["contentHash", "platform"].includes(key))
    .slice(0, 8);
  if (entries.length === 0) return "";
  return `<div class="detail-meta">${entries.map(([key, value]) => `<span><b>${escapeHtml(humanize(key))}</b>${escapeHtml(value)}</span>`).join("")}</div>`;
};

const closeDetail = () => {
  const dialog = $("#detail-dialog");
  if (dialog.open) dialog.close();
  lastFocusedElement?.focus?.();
  lastFocusedElement = null;
};

const openItem = (itemId) => {
  const item = state.data?.items?.find((candidate) => candidate.id === itemId);
  if (!item) return;
  const meta = source(item.source);
  const decisions = (state.data?.decisions ?? []).filter((decision) => decision.itemId === item.id);
  const url = safeHttpUrl(item.url) ? `<a class="detail-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Open source ↗</a>` : "";
  const dialog = $("#detail-dialog");
  lastFocusedElement = document.activeElement;
  $("#detail-content").innerHTML = `<div class="dialog-close"><button id="close-detail" type="button" aria-label="Close detail">×</button></div><div class="detail-source"><span class="stream-icon ${escapeHtml(meta.className)}">${escapeHtml(meta.icon)}</span>${escapeHtml(meta.label)} · ${escapeHtml(formatDate(item.createdAt ?? item.observedAt))}</div><h2 id="detail-title">${escapeHtml(item.title)}</h2>${metadataMarkup(item)}<div class="detail-content">${escapeHtml(item.content ?? "No content excerpt stored for this item.")}</div>${url}${resourceMarkup(item)}<div class="detail-section"><h3>Jev decisions</h3><div class="decision-stack">${decisions.length === 0 ? '<div class="detail-content">No decision was needed for this item.</div>' : decisions.map((decision) => `<div class="decision-row"><div><div class="decision-name">${escapeHtml(humanize(decision.decision))}</div><div class="decision-answer">${escapeHtml(decisionSummary(decision))}</div></div><div><div class="decision-meter"><span style="width:${confidence(decision)}%"></span></div><div class="decision-percent">${confidence(decision)}%</div></div></div>`).join("")}</div></div>`;
  if (!dialog.open) dialog.showModal();
  $("#close-detail").addEventListener("click", closeDetail, { once: true });
  $("#close-detail").focus();
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
  renderCourseFilter();
  renderStream();
};

const handleEvent = (event) => {
  let payload;
  try { payload = JSON.parse(event.data); } catch { return; }
  if (payload.type === "run_snapshot") {
    const run = payload.run ?? {};
    state.liveRunId = run.runId ?? "";
    state.liveRunActive = run.active === true && Boolean(state.liveRunId);
    state.liveStage = run.stage ?? "";
    state.liveLastEventAt = run.lastEventAt ?? run.startedAt ?? "";
    state.pipeline = {};
    if (state.liveRunActive && state.liveStage) {
      const activeIndex = stages.indexOf(state.liveStage);
      for (let index = 0; index < activeIndex; index += 1) state.pipeline[stages[index]] = "completed";
      state.pipeline[state.liveStage] = "started";
    }
    fetchState().catch(() => {});
  } else if (payload.type === "run_started") {
    state.liveRunId = payload.runId ?? "";
    state.liveRunActive = true;
    state.liveStage = "collect";
    state.liveLastEventAt = payload.at ?? "";
    state.pipeline = { collect: "started" };
    pushActivity("Run started", "Checking the local sources", "cyan", payload.at);
  } else if (payload.type === "stage") {
    state.liveRunId = payload.runId ?? state.liveRunId;
    state.liveRunActive = true;
    state.liveStage = payload.stage ?? state.liveStage;
    state.liveLastEventAt = payload.at ?? state.liveLastEventAt;
    state.pipeline[payload.stage] = payload.status;
    const stageLabel = payload.stage === "jev" ? "Jev decisions" : humanize(payload.stage);
    pushActivity(`${stageLabel} ${payload.status === "started" ? "started" : "complete"}`, payload.status === "started" ? "The local run is moving" : "Step complete", payload.status === "started" ? "lime" : "cyan", payload.at);
  } else if (payload.type === "items_collected") {
    pushActivity("Items collected", `${payload.count} items found`, "cyan", payload.at);
  } else if (payload.type === "decisions_completed") {
    pushActivity("Decisions recorded", `${payload.count} typed decisions saved`, "lime", payload.at);
  } else if (payload.type === "actions_completed") {
    pushActivity("Actions checked", `${payload.count} possible actions reviewed`, "gold", payload.at);
  } else if (payload.type === "run_completed") {
    state.liveRunActive = false;
    state.liveStage = "";
    state.liveLastEventAt = payload.at ?? state.liveLastEventAt;
    state.pipeline = {};
    if (state.data) {
      const { error: _previousError, ...previousRun } = state.data.run;
      state.data = {
        ...state.data,
        run: {
          ...previousRun,
          active: false,
          runId: payload.runId,
          stage: "briefing",
          completedAt: payload.at,
          lastEventAt: payload.at,
          itemCount: payload.itemCount,
          decisionCount: payload.decisionCount,
          actionCount: payload.actionCount,
        },
      };
    }
    pushActivity("Run complete", `${payload.itemCount} items · ${payload.decisionCount} decisions`, "lime", payload.at);
    fetchState().catch(() => {});
  } else if (payload.type === "run_failed") {
    state.liveRunActive = false;
    state.liveStage = "";
    state.liveLastEventAt = payload.at ?? state.liveLastEventAt;
    state.pipeline = {};
    if (state.data) {
      const { completedAt: _previousCompletedAt, ...previousRun } = state.data.run;
      state.data = {
        ...state.data,
        run: {
          ...previousRun,
          active: false,
          runId: payload.runId,
          lastEventAt: payload.at,
          error: payload.error,
        },
      };
    }
    pushActivity("Run stopped", payload.error, "coral", payload.at);
    toast(payload.error, "error");
    fetchState().catch(() => {});
  } else if (payload.type === "state_invalidated") {
    fetchState().catch(() => {});
  }
  renderHeader();
  renderPipeline();
};

const runPulse = async (mock = false) => {
  const button = $("#run-button");
  button.disabled = true;
  button.classList.add("is-loading");
  button.innerHTML = '<span class="run-icon">◌</span><span>Starting run</span>';
  try {
    const response = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mock }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Could not start run.");
    toast(mock ? "Demo run started." : "Run started.", "success");
  } catch (error) {
    toast(errorMessage(error, "Could not start run."), "error");
    renderHeader();
  }
};

const resolveReview = async (button) => {
  button.disabled = true;
  try {
    const response = await fetch("/api/reviews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemId: button.dataset.reviewItem, decision: button.dataset.reviewDecision, status: button.dataset.reviewStatus }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Could not save review.");
    toast(button.dataset.reviewStatus === "approved" ? "Item marked reviewed." : "Item dismissed from the queue.", "success");
    await fetchState();
  } catch (error) {
    button.disabled = false;
    toast(errorMessage(error, "Could not save review."), "error");
  }
};

const clearFilters = () => {
  state.filter = "all";
  state.course = "";
  state.query = "";
  state.streamLimit = 50;
  window.localStorage.removeItem("morning-agent:filter");
  window.localStorage.removeItem("morning-agent:course");
  $("#search-input").value = "";
  $("#search-clear").hidden = true;
  $("#course-filter").value = "";
  syncFilterControls();
  renderStream();
};

const selectView = (view) => {
  const control = view === "control";
  state.view = control ? "control" : "everything";
  window.localStorage.setItem("morning-agent:view", state.view);
  $("#control-view").classList.toggle("is-hidden", !control);
  $("#everything-view").classList.toggle("is-hidden", control);
  $$(".nav-item").forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#crumb-view").textContent = control ? "Overview" : "All activity";
};

$$('[data-view]').forEach((button) => button.addEventListener("click", () => selectView(button.dataset.view)));
$("#run-button").addEventListener("click", () => runPulse(false));
$("#search-input").addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  state.streamLimit = 50;
  $("#search-clear").hidden = state.query.length === 0;
  renderStream();
});
$("#search-clear").addEventListener("click", () => {
  $("#search-input").value = "";
  state.query = "";
  state.streamLimit = 50;
  $("#search-clear").hidden = true;
  $("#search-input").focus();
  renderStream();
});
$("#course-filter").addEventListener("change", (event) => {
  state.course = event.target.value;
  state.streamLimit = 50;
  window.localStorage.setItem("morning-agent:course", state.course);
  renderStream();
});
$("#stream-more").addEventListener("click", () => {
  state.streamLimit += 50;
  renderStream();
});
const syncFilterControls = () => {
  $$('[data-filter]').forEach((candidate) => {
    const active = candidate.dataset.filter === state.filter;
    candidate.classList.toggle("is-active", active);
    candidate.setAttribute("aria-pressed", active ? "true" : "false");
  });
};
$$('[data-filter]').forEach((button) => button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  state.streamLimit = 50;
  window.localStorage.setItem("morning-agent:filter", state.filter);
  if (button.closest(".source-stack")) selectView("everything");
  syncFilterControls();
  renderStream();
}));
document.addEventListener("click", (event) => {
  const clearButton = event.target.closest("[data-clear-filters]");
  if (clearButton) { clearFilters(); return; }
  const reviewButton = event.target.closest("[data-review-item]");
  if (reviewButton) { resolveReview(reviewButton); return; }
  const itemButton = event.target.closest("[data-open-item]");
  if (itemButton) openItem(itemButton.dataset.openItem);
});
$("#detail-dialog").addEventListener("click", (event) => { if (event.target === $("#detail-dialog")) closeDetail(); });
$("#detail-dialog").addEventListener("cancel", () => { window.setTimeout(closeDetail, 0); });
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "1") { event.preventDefault(); selectView("control"); }
  if ((event.metaKey || event.ctrlKey) && event.key === "2") { event.preventDefault(); selectView("everything"); }
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? "")) {
    event.preventDefault(); $("#search-input").focus();
  }
});

const connectEvents = () => {
  const stream = new EventSource("/api/events");
  stream.onopen = () => setConnectionStatus("live");
  stream.onerror = () => setConnectionStatus("reconnecting");
  ["run_snapshot", "run_started", "stage", "items_collected", "decisions_completed", "actions_completed", "run_completed", "run_failed", "state_invalidated"].forEach((name) => stream.addEventListener(name, handleEvent));
};

const tickClock = () => {
  const now = new Date();
  $("#greeting-prefix").textContent = greeting(now.getHours());
  $("#current-day").textContent = new Intl.DateTimeFormat("en-HK", { weekday: "long", day: "numeric", month: "long" }).format(now);
  $("#current-time").textContent = new Intl.DateTimeFormat("en-HK", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(now);
};

tickClock();
window.setInterval(tickClock, 1_000);
selectView(state.view);
syncFilterControls();
connectEvents();
fetchState().catch(() => {});
window.setInterval(() => fetchState().catch(() => {}), 10_000);
