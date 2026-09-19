const validFilters = new Set(["all", "deadlines", "review", "email", "courses", "work", "moodle", "news", "edstem", "files"]);
const streamScopeLabels = {
  all: "All items",
  deadlines: "Deadlines",
  review: "Review queue",
  email: "Inbox",
  courses: "Coursework",
  work: "Work",
  moodle: "Moodle",
  news: "Daily news",
  edstem: "Ed Lessons",
  files: "Files",
};
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
let initialLoadErrorShown = false;

const stages = ["collect", "normalize", "jev", "policy", "actions", "briefing"];
const sourceMeta = {
  email: { label: "Inbox", icon: "@", className: "email" },
  moodle: { label: "Moodle", icon: "M", className: "moodle" },
  work: { label: "Work", icon: "⌘", className: "work" },
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

const cleanDisplayText = (value) => String(value ?? "")
  .replace(/\bSkip to (?:sidebar )?(?:navigation menu|hidden blocks|page footer|main content|-)(?=\s|$)/giu, " ")
  .replace(/\bBlocks\s+Close(?:\s+Blocks)?(?:\s+Close\s+Blocks)?/giu, " ")
  .replace(/\bSkip\s+(?:To\s+)?do(?:\s+To\s+do)*/giu, " ")
  .replace(/\bThere are no upcoming events\s+Go to calendar\.\.\./giu, " ")
  .replace(/\bSkip\s+ReadingList@HKUL(?:\s+ReadingList@HKUL)?\s+Reading list for\s+\S+\s+Close\s+Light Mode\s+\d+\s+JS\s+Open course index\s*/iu, " ")
  .replace(/\bSkip\s+ReadingList@HKUL\s+R\b/giu, " ")
  .replace(/\bDashboard\s+My courses\s+\d+\s+[\s\S]*?\bOpen course index\s*/iu, " ")
  .replace(/\bJS\s+Open course index\s*/iu, " ")
  .replace(/\bHome\s+Courses\s+\S*20\d{2}\S*\s+/iu, " ")
  .replace(/\bGeneral\s+(Tutorial|Lecture)\s+Participation\s+Blocks\s+\1\s+Participation\s+Blocks\s+Completion requirements\b/giu, "General $1 Participation · Completion requirements")
  .replace(/\s+Blocks(?:\s+Blocks){2,}\s+FAQs for Teachers[\s\S]*$/iu, " ")
  .replace(/\s+/gu, " ")
  .trim();

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

const latestObservedAt = () => {
  let latest = "";
  for (const item of state.data?.items ?? []) {
    const value = item.observedAt ?? item.createdAt;
    if (!value || (latest !== "" && new Date(value).getTime() <= new Date(latest).getTime())) continue;
    latest = value;
  }
  return latest;
};

const snapshotIsStale = () => {
  if (!state.data?.metrics?.total) return false;
  const timestamp = new Date(latestObservedAt()).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp >= 86_400_000;
};

const source = (name) => sourceMeta[name] ?? { label: name, icon: "•", className: "other" };

const upcomingDeadlineIds = () => new Set((state.data?.deadlines ?? []).map((deadline) => deadline.id));

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

const itemDisplayTimestamp = (item) => item.createdAt ?? item.observedAt ?? "";

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

const setWorkspaceBusy = (busy) => {
  $("#workspace-main")?.setAttribute("aria-busy", busy ? "true" : "false");
};

const showDataBanner = (title, message) => {
  const banner = $("#data-banner");
  if (!banner) return;
  $("#data-banner-title").textContent = title;
  $("#data-banner-message").textContent = message;
  banner.hidden = false;
};

const hideDataBanner = () => {
  $("#data-banner").hidden = true;
};

const renderUnavailable = () => {
  $("#pulse-label").textContent = "Unavailable";
  $("#status-caption").textContent = "The local dashboard service is unavailable. Try again when it is running.";
  $("#status-caption").classList.remove("is-stale");
  $("#pipeline-kicker").textContent = "Connection";
  $("#pipeline-title").textContent = "Collection unavailable";
  $("#pipeline-status").textContent = "Unavailable";
  $("#pipeline-footnote").textContent = "Could not read local state.";
  $("#review-list").innerHTML = '<div class="empty-state"><div><strong>Review queue unavailable.</strong><p>Reconnect to read pending decisions.</p></div></div>';
  $("#activity-kicker").textContent = "Connection";
  $("#activity-title").textContent = "Local state unavailable";
  $("#activity-list").innerHTML = '<div class="empty-state"><div><strong>Nothing to show yet.</strong><p>The local state service did not respond.</p></div></div>';
  $("#deadline-list").innerHTML = '<div class="empty-state"><div><strong>Upcoming dates unavailable.</strong><p>Reconnect to read your saved deadlines.</p></div></div>';
  $("#focus-breakdown").innerHTML = '<div class="empty-state"><div><strong>Attention signals unavailable.</strong><p>Reconnect to calculate the current load.</p></div></div>';
  $("#stream-table").innerHTML = '<div class="empty-state"><div><strong>Local activity unavailable.</strong><p>Reconnect to browse your saved items.</p></div></div>';
  $("#stream-result-count").textContent = "Unavailable";
  $("#stream-pagination").textContent = "Unavailable";
  renderPipeline();
};

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
  if (label) label.textContent = status === "live" ? "Connected" : status === "reconnecting" ? "Reconnecting" : state.data === null ? "Loading" : "Connecting";
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
  const firstLoad = state.data === null;
  if (firstLoad) setWorkspaceBusy(true);
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not read local agent state.");
    state.data = await response.json();
    initialLoadErrorShown = false;
    setWorkspaceBusy(false);
    hideDataBanner();
    setConnectionStatus("live");
    reconcileLiveRun();
    render();
  } catch (error) {
    setConnectionStatus("reconnecting");
    if (state.data === null) {
      setWorkspaceBusy(false);
      const message = errorMessage(error, "Could not read local agent state.");
      showDataBanner("Local state unavailable", message);
      renderUnavailable();
      if (!initialLoadErrorShown) {
        toast(message, "error");
        initialLoadErrorShown = true;
      }
    } else {
      showDataBanner("Connection interrupted", "Showing the last saved snapshot while the local service reconnects.");
    }
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
  const latestObservation = latestObservedAt();
  const hasActivityScope = state.filter !== "all" || state.course !== "" || state.query !== "";
  const visibleCount = hasActivityScope ? filteredItems().length : metrics.total ?? 0;
  const visibleLabel = `${visibleCount} item${visibleCount === 1 ? "" : "s"}${hasActivityScope ? " · filtered" : ""}`;
  $("#everything-count").textContent = `${visibleLabel}${latestObservation === "" ? "" : ` · last observed ${relativeTime(latestObservation)}`}`;
  $("#donut-total").textContent = metrics.total ?? 0;
  const courses = new Set((state.data?.items ?? []).map(courseInfo).filter(Boolean).map((course) => course.key));
  $("#metric-course-count").textContent = `${courses.size} course${courses.size === 1 ? "" : "s"}`;
};

const renderHeader = () => {
  const run = effectiveRun();
  const latestObservation = latestObservedAt();
  const isStaleSnapshot = snapshotIsStale();
  const hasRunHistory = Boolean(run.completedAt);
  const hasSnapshot = Boolean(state.data?.metrics?.total);
  const label = run.active ? "Processing" : run.error ? "Needs attention" : run.completedAt ? "Last run complete" : "Ready";
  $("#pulse-label").textContent = label;
  $("#pipeline-kicker").textContent = run.active ? "Live run" : hasRunHistory ? "Run history" : hasSnapshot ? "Local snapshot" : "Run history";
  $("#pipeline-title").textContent = run.active ? "Collecting now" : hasRunHistory ? "Last collection" : hasSnapshot ? "Collection status" : "First collection";
  $("#pipeline-status").textContent = run.active ? "Running" : run.error ? "Error" : "Idle";
  $("#pipeline-status").classList.toggle("is-running", run.active);
  $("#status-caption").classList.toggle("is-stale", isStaleSnapshot && !run.active && !run.error);
  $("#status-caption").textContent = run.active
    ? "Checking your latest sources."
    : run.error
      ? `The last run stopped: ${run.error}`
      : state.data?.metrics?.total
        ? `${state.data.metrics.total} items in view · last observed ${latestObservation === "" ? "unknown" : relativeTime(latestObservation)}${isStaleSnapshot ? " · refresh recommended" : ""}.`
        : "Nothing has been collected yet. Run the first check when you are ready.";
  $("#pipeline-footnote").textContent = run.active
    ? `Run ${run.runId?.slice(0, 8) ?? "—"} · ${humanize(run.stage ?? "collect")}`
    : run.completedAt
      ? `Last run ${relativeTime(run.completedAt)} · ${run.itemCount ?? 0} items · ${run.decisionCount ?? 0} decisions`
      : state.data?.metrics?.total
        ? `${latestObservation === "" ? "No observation time" : `Last observed ${relativeTime(latestObservation)}`} · ${state.data.metrics.total} stored items · ${isStaleSnapshot ? "refresh recommended" : "run again for fresh data"}`
        : "Waiting for the first run";
  $("#activity-status").textContent = run.active ? "updating" : connectionStatus === "live" ? "saved locally" : "offline";
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

const priorityItems = () => {
  const items = new Map((state.data?.items ?? []).map((item) => [item.id, item]));
  const candidates = new Map();
  const addCandidate = (item, title, detail, tone, score) => {
    const current = candidates.get(item.id);
    if (current !== undefined && current.score >= score) return;
    candidates.set(item.id, {
      itemId: item.id,
      title,
      detail,
      tone,
      score,
      at: item.observedAt,
    });
  };

  for (const decision of state.data?.decisions ?? []) {
    const item = items.get(decision.itemId);
    if (item === undefined) continue;
    const output = decision.output ?? {};
    if (decision.decision === "requiresAction" && output.actionRequired === true) {
      const urgency = output.urgency ?? "soon";
      const score = urgency === "today" ? 100 : urgency === "soon" ? 82 : urgency === "later" ? 55 : 50;
      const urgencyLabel = urgency === "today" ? "needs attention today" : urgency === "later" ? "action suggested later" : "action suggested soon";
      addCandidate(
        item,
        item.title,
        `${source(item.source).label} · ${urgencyLabel}`,
        urgency === "today" ? "coral" : "gold",
        score,
      );
    } else if (decision.decision === "importantEmail" && output.important === true && item.metadata?.unread === true) {
      addCandidate(item, `${item.title}`, `${source(item.source).label} · important inbox`, "cyan", 70);
    }
  }

  for (const deadline of state.data?.deadlines ?? []) {
    const item = items.get(deadline.id);
    if (item === undefined) continue;
    const hoursUntil = (new Date(deadline.deadline).getTime() - Date.now()) / 3_600_000;
    const score = 95 - Math.max(0, Math.min(20, hoursUntil / 24));
    addCandidate(
      item,
      item.title,
      `${source(deadline.source).label} · due ${formatDate(deadline.deadline)} at ${formatTime(deadline.deadline)}`,
      "coral",
      score,
    );
  }

  return Array.from(candidates.values()).sort((left, right) => right.score - left.score).slice(0, 4);
};

const renderActivity = () => {
  const run = effectiveRun();
  const priorities = state.events.length === 0 && !run.active && !run.error ? priorityItems() : [];
  const fallback = run.error
    ? { title: "Last run stopped", detail: run.error, tone: "coral", at: run.lastEventAt ?? new Date().toISOString() }
    : run.active
    ? { title: "Run in progress", detail: `${humanize(run.stage ?? "collect")} stage is active`, tone: "lime", at: run.lastEventAt ?? new Date().toISOString() }
    : run.completedAt
        ? { title: "Last run complete", detail: `${run.itemCount ?? 0} items · ${run.decisionCount ?? 0} decisions`, tone: "lime", at: run.completedAt }
        : state.data?.metrics?.total
          ? { title: "Local state loaded", detail: `${state.data.metrics.total} items ready · run again for fresh data`, tone: "cyan", at: state.data.generatedAt ?? new Date().toISOString() }
          : { title: "Ready", detail: "Waiting for the first run", tone: "neutral", at: new Date().toISOString() };
  const events = state.events.length > 0 ? state.events : priorities.length > 0 ? priorities : [fallback];
  $("#activity-kicker").textContent = priorities.length > 0 && state.events.length === 0 ? "Priority" : "Recent activity";
  $("#activity-title").textContent = priorities.length > 0 && state.events.length === 0 ? "Needs attention" : "Latest changes";
  $("#activity-list").innerHTML = events.map((event) => {
    const body = `<span class="activity-pip ${escapeHtml(event.tone)}"></span><span><span class="activity-title">${escapeHtml(event.title)}</span><span class="activity-detail">${escapeHtml(event.detail)}</span></span><span class="activity-time">${escapeHtml(relativeTime(event.at))}</span>`;
    return event.itemId === undefined
      ? `<div class="activity-row">${body}</div>`
      : `<button class="activity-row activity-link" data-open-item="${escapeHtml(event.itemId)}" type="button" aria-label="Open ${escapeHtml(event.title)}">${body}<span class="activity-open" aria-hidden="true">↗</span></button>`;
  }).join("");
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
  const scopedItems = filteredItems();
  const counts = scopedItems.reduce((totals, item) => {
    if (item.source === "email") totals.email += 1;
    else if (item.source === "moodle") totals.moodle += 1;
    else if (item.source === "github") totals.github += 1;
    else if (item.source === "calendar") totals.calendar += 1;
    else if (item.source === "work") totals.work += 1;
    else if (item.source === "news") totals.news += 1;
    else if (item.source === "edstem") totals.edstem += 1;
    else if (item.source === "downloads") totals.downloads += 1;
    return totals;
  }, { email: 0, moodle: 0, github: 0, calendar: 0, work: 0, news: 0, edstem: 0, downloads: 0 });
  const sourceGroups = [
    { key: "email", label: source("email").label, count: counts.email ?? 0, color: "var(--lime)" },
    { key: "moodle", label: source("moodle").label, count: counts.moodle ?? 0, color: "var(--violet)" },
    { key: "work", label: source("work").label, count: (counts.github ?? 0) + (counts.calendar ?? 0), color: "var(--cyan)" },
    { key: "news", label: source("news").label, count: counts.news ?? 0, color: "var(--gold)" },
    { key: "edstem", label: source("edstem").label, count: counts.edstem ?? 0, color: "var(--coral)" },
    { key: "downloads", label: source("downloads").label, count: counts.downloads ?? 0, color: "var(--coral)" },
  ];
  const total = sourceGroups.reduce((sum, group) => sum + group.count, 0);
  $("#donut-total").textContent = total;
  $("#source-scope").textContent = state.filter === "all" && state.course === "" && state.query === "" ? "all items" : "current view";
  let cursor = 0;
  const segments = sourceGroups.map((group) => {
    const count = group.count;
    const start = total === 0 ? 0 : cursor / total * 100;
    cursor += count;
    const end = total === 0 ? 0 : cursor / total * 100;
    return `${group.color} ${start}% ${end}%`;
  });
  $("#source-donut").style.background = total === 0 ? "conic-gradient(rgba(255,255,255,.08) 0 100%)" : `conic-gradient(${segments.join(", ")})`;
  $("#source-bars").innerHTML = sourceGroups.map((group) => {
    const count = group.count;
    const width = total === 0 || count === 0 ? 0 : Math.max(4, count / total * 100);
    return `<div class="source-bar-row"><span>${escapeHtml(group.label)}</span><div class="source-bar-track"><div class="source-bar-fill" style="--bar-color:${group.color};width:${width}%"></div></div><b>${count}</b></div>`;
  }).join("");
};

const renderFocus = () => {
  const scopedItems = filteredItems();
  const itemIds = new Set(scopedItems.map((item) => item.id));
  const unread = scopedItems.filter((item) => item.metadata?.unread === true).length;
  const deadlines = (state.data?.deadlines ?? []).filter((deadline) => itemIds.has(deadline.id)).length;
  const humanReview = (state.data?.lowConfidence ?? []).filter((entry) => itemIds.has(entry.item.id)).length;
  const total = scopedItems.length;
  const weighted = total === 0 ? 0 : Math.min(100, Math.round((unread + deadlines * 1.6 + humanReview * 2) / Math.max(1, total) * 100));
  $("#focus-score").textContent = `${weighted}%`;
  $("#focus-meter").setAttribute("aria-valuenow", String(weighted));
  $("#focus-meter").setAttribute("aria-valuetext", `${weighted}% attention load`);
  $("#focus-meter-fill").style.width = `${weighted}%`;
  $("#focus-breakdown").innerHTML = [
    ["Unread mail", unread],
    ["Deadlines, 7 days", deadlines],
    ["Human review", humanReview],
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
  const reviewItemIds = new Set((state.data?.lowConfidence ?? []).map((entry) => entry.item.id));
  const deadlineIds = upcomingDeadlineIds();
  return items.filter((item) => {
    const matchesFilter = state.filter === "all"
      || (state.filter === "work" && ["github", "calendar"].includes(item.source))
      || (state.filter === "deadlines" && deadlineIds.has(item.id))
      || (state.filter === "review" && reviewItemIds.has(item.id))
      || (state.filter === "moodle" && item.source === "moodle")
      || (state.filter === "courses" && ["moodle", "edstem"].includes(item.source))
      || (state.filter === "email" && item.source === "email")
      || (state.filter === "news" && item.source === "news")
      || (state.filter === "edstem" && item.source === "edstem")
      || (state.filter === "files" && item.source === "downloads");
    const itemCourse = courseInfo(item);
    const matchesCourse = state.course === "" || itemCourse?.key === state.course;
    const haystack = `${item.title} ${item.content ?? ""} ${item.source} ${itemCourse?.label ?? ""}`.toLowerCase();
    return matchesFilter && matchesCourse && haystack.includes(state.query.toLowerCase());
  }).sort((left, right) => {
    const leftTime = new Date(itemDisplayTimestamp(left)).getTime();
    const rightTime = new Date(itemDisplayTimestamp(right)).getTime();
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime;
    if (Number.isFinite(rightTime)) return 1;
    if (Number.isFinite(leftTime)) return -1;
    return left.id.localeCompare(right.id);
  });
};

const emptyStreamCopy = () => {
  if (state.query !== "") return { title: "No matches found.", detail: `Nothing matches “${state.query}”. Try a different search or clear it.` };
  if (state.course !== "") {
    const selectedCourse = $("#course-filter")?.selectedOptions?.[0]?.textContent ?? "this course";
    return { title: `No items in ${selectedCourse}.`, detail: "Run a check or choose another course to see more activity." };
  }
  return {
    all: { title: "No items yet.", detail: "Run a check to populate your local activity feed." },
    deadlines: { title: "No upcoming deadlines.", detail: "No saved deadlines match the current view." },
    review: { title: "Nothing needs review.", detail: "Your current decisions are above the review threshold." },
    email: { title: "Inbox is clear.", detail: "No inbox items match the current view." },
    courses: { title: "No coursework here yet.", detail: "Moodle and Ed Lessons items will appear after a check." },
    work: { title: "No work items here yet.", detail: "GitHub and Calendar items will appear after a check." },
    moodle: { title: "No Moodle items here yet.", detail: "Moodle coursework will appear after a check." },
    news: { title: "No daily news here yet.", detail: "News items will appear after a check." },
    edstem: { title: "No Ed Lessons here yet.", detail: "Lesson updates will appear after a check." },
    files: { title: "No saved files here yet.", detail: "Downloaded files will appear after a check." },
  }[state.filter] ?? { title: "No items here yet.", detail: "Run a check or loosen the filter to see more of your day." };
};

const renderStream = () => {
  const items = filteredItems();
  const deadlineIds = upcomingDeadlineIds();
  $("#stream-title").textContent = state.query !== "" || state.course !== ""
    ? "Matching items"
    : streamScopeLabels[state.filter] ?? "All items";
  const pendingReviewsByItem = new Map();
  for (const entry of state.data?.lowConfidence ?? []) {
    const pending = pendingReviewsByItem.get(entry.item.id) ?? [];
    pending.push(entry.decision);
    pendingReviewsByItem.set(entry.item.id, pending);
  }
  const visibleItems = items.slice(0, state.streamLimit);
  const filterSuffix = state.filter !== "all" || state.query || state.course ? " · filtered" : "";
  $("#stream-result-count").textContent = `${items.length} item${items.length === 1 ? "" : "s"}${filterSuffix}`;
  if (items.length === 0) {
    const clearAction = state.filter !== "all" || state.course !== "" || state.query !== ""
      ? '<button class="empty-action" data-clear-filters type="button">Clear filters</button>'
      : "";
    const copy = emptyStreamCopy();
    $("#stream-table").innerHTML = `<div class="empty-state"><div><strong>${escapeHtml(copy.title)}</strong><p>${escapeHtml(copy.detail)}</p>${clearAction}</div></div>`;
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
    const isDeadline = deadlineIds.has(item.id);
    const isLesson = item.source === "edstem" && item.metadata?.kind === "lesson";
    const itemCourse = courseInfo(item);
    const stateClass = hot ? "is-hot" : unread ? "is-unread" : isDeadline ? "is-deadline" : "";
    const stateText = hot ? `${confidence(weakest)}% review` : unread ? "unread" : isDeadline ? "deadline" : isLesson ? "lesson" : "observed";
    const subtitle = [itemCourse?.label, cleanDisplayText(item.content ?? "")].filter(Boolean).join(" · ").slice(0, 120);
    return `<button class="stream-row" data-open-item="${escapeHtml(item.id)}" type="button" aria-label="Open ${escapeHtml(item.title)}"><span class="stream-signal"><span class="stream-icon ${escapeHtml(meta.className)}">${escapeHtml(meta.icon)}</span><span><span class="stream-title">${escapeHtml(item.title)}</span><span class="stream-subtitle">${escapeHtml(subtitle)}</span></span></span><span class="stream-source">${escapeHtml(meta.label)}</span><span class="stream-when">${escapeHtml(relativeTime(itemDisplayTimestamp(item)))}</span><span class="stream-state ${stateClass}">${stateText}</span></button>`;
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

const metadataLabel = (key) => ({
  sender: "From",
  senderEmail: "Email",
  unread: "Unread",
  receivedAt: "Received",
  creationTime: "Created",
  modifiedTime: "Modified",
  courseId: "Course ID",
  kind: "Type",
}[key] ?? humanize(key));

const metadataValue = (key, value) => {
  if (key === "unread" && typeof value === "boolean") return value ? "Yes" : "No";
  if ((key.endsWith("At") || key === "creationTime" || key === "modifiedTime") && typeof value === "string") {
    const timestamp = new Date(value);
    if (Number.isFinite(timestamp.getTime())) return `${formatDate(value)} · ${formatTime(value)}`;
  }
  if (key === "kind") return humanize(value);
  return String(value);
};

const metadataMarkup = (item) => {
  const metadata = item.metadata ?? {};
  const entries = [];
  const sender = typeof metadata.sender === "string" ? metadata.sender.trim() : "";
  const senderEmail = typeof metadata.senderEmail === "string" ? metadata.senderEmail.trim() : "";
  if (sender !== "" || senderEmail !== "") entries.push(["sender", [sender, senderEmail].filter(Boolean).join(" · ")]);
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "resources" || key === "sender" || key === "senderEmail") continue;
    if (!["string", "number", "boolean"].includes(typeof value)) continue;
    if (["contentHash", "platform", "href", "provider", "threadId", "path", "courseId"].includes(key)) continue;
    entries.push([key, metadataValue(key, value)]);
  }
  if (typeof metadata.course !== "string" && typeof metadata.courseId === "string") {
    entries.push(["courseId", metadataValue("courseId", metadata.courseId)]);
  }
  const visibleEntries = entries.slice(0, 8);
  if (visibleEntries.length === 0) return "";
  return `<div class="detail-meta">${visibleEntries.map(([key, value]) => `<span><b>${escapeHtml(metadataLabel(key))}</b>${escapeHtml(value)}</span>`).join("")}</div>`;
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
  $("#detail-content").innerHTML = `<div class="dialog-close"><button id="close-detail" type="button" aria-label="Close detail">×</button></div><div class="detail-source"><span class="stream-icon ${escapeHtml(meta.className)}">${escapeHtml(meta.icon)}</span>${escapeHtml(meta.label)} · ${escapeHtml(formatDate(item.createdAt ?? item.observedAt))}</div><h2 id="detail-title">${escapeHtml(item.title)}</h2>${metadataMarkup(item)}<div class="detail-content">${escapeHtml(cleanDisplayText(item.content ?? "No content excerpt stored for this item."))}</div>${url}${resourceMarkup(item)}<div class="detail-section"><h3>Jev decisions</h3><div class="decision-stack">${decisions.length === 0 ? '<div class="detail-content">No decision was needed for this item.</div>' : decisions.map((decision) => `<div class="decision-row"><div><div class="decision-name">${escapeHtml(humanize(decision.decision))}</div><div class="decision-answer">${escapeHtml(decisionSummary(decision))}</div></div><div><div class="decision-meter"><span style="width:${confidence(decision)}%"></span></div><div class="decision-percent">${confidence(decision)}%</div></div></div>`).join("")}</div></div>`;
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

const renderActivityScope = () => {
  renderMetrics();
  renderSourceVisual();
  renderFocus();
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
  renderActivityScope();
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
  $("#crumb-view").textContent = control ? "Today" : "All activity";
  syncFilterControls();
  if (!control && state.data !== null) renderActivityScope();
};

$("#run-button").addEventListener("click", () => runPulse(false));
$("#data-retry").addEventListener("click", async () => {
  const button = $("#data-retry");
  button.disabled = true;
  button.textContent = "Trying…";
  showDataBanner("Reconnecting", "Trying to read the local state again.");
  try { await fetchState(); } catch {}
  button.disabled = false;
  button.textContent = "Try again";
});
$("#search-input").addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  state.streamLimit = 50;
  $("#search-clear").hidden = state.query.length === 0;
  renderActivityScope();
});
$("#search-clear").addEventListener("click", () => {
  $("#search-input").value = "";
  state.query = "";
  state.streamLimit = 50;
  $("#search-clear").hidden = true;
  $("#search-input").focus();
  renderActivityScope();
});
$("#course-filter").addEventListener("change", (event) => {
  state.course = event.target.value;
  state.streamLimit = 50;
  window.localStorage.setItem("morning-agent:course", state.course);
  renderActivityScope();
});
$("#stream-more").addEventListener("click", () => {
  state.streamLimit += 50;
  renderStream();
});
const syncFilterControls = () => {
  $$('[data-filter]').forEach((candidate) => {
    const active = state.view === "everything" && candidate.dataset.filter === state.filter;
    candidate.classList.toggle("is-active", active);
    candidate.setAttribute("aria-pressed", active ? "true" : "false");
  });
};
const openFilteredView = (filter) => {
  state.filter = validFilters.has(filter) ? filter : "all";
  state.course = "";
  state.query = "";
  state.streamLimit = 50;
  window.localStorage.setItem("morning-agent:filter", state.filter);
  window.localStorage.removeItem("morning-agent:course");
  $("#search-input").value = "";
  $("#search-clear").hidden = true;
  $("#course-filter").value = "";
  selectView("everything");
};
const activateViewTarget = (button) => {
  if (button.dataset.filterTarget !== undefined) {
    openFilteredView(button.dataset.filterTarget);
    return;
  }
  selectView(button.dataset.view);
};
$$('[data-view]').forEach((button) => button.addEventListener("click", () => activateViewTarget(button)));
$("[data-deadline-view]").addEventListener("click", () => {
  state.filter = "deadlines";
  state.streamLimit = 50;
  window.localStorage.setItem("morning-agent:filter", state.filter);
  selectView("everything");
});
$$('[data-filter]').forEach((button) => button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  state.streamLimit = 50;
  window.localStorage.setItem("morning-agent:filter", state.filter);
  if (button.closest(".source-stack") || state.view !== "everything") selectView("everything");
  else renderActivityScope();
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
  const viewShortcut = event.target instanceof Element
    ? event.target.closest('[data-view][role="button"]')
    : null;
  if (viewShortcut && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    activateViewTarget(viewShortcut);
    return;
  }
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
