import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

import { Alert } from "@/components/arc/alert/alert";
import { Badge, type BadgeTone } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { MetricCard } from "@/components/arc/metric-card/metric-card";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { SortableDataTable, type DataColumn } from "@/components/arc/sortable-data-table/sortable-data-table";

import styles from "./arc-ui.module.css";

type MetricSet = {
  total: number;
  emails: number;
  unread: number;
  coursework: number;
  review: number;
  courses: number;
};

export type ActivityRow = Record<string, unknown> & {
  id: string;
  title: string;
  subtitle: string;
  source: string;
  sortTime: string;
  when: string;
  status: string;
  tone: BadgeTone;
};

type ActivityState =
  | { kind: "loading" }
  | { kind: "unavailable"; retry: () => void }
  | { kind: "empty"; title: string; description: string; clearFilters: boolean }
  | { kind: "ready"; rows: ActivityRow[] };

type RunButtonState = { label: string; disabled: boolean; loading: boolean };

type ServiceKey = "downloads" | "calendar" | "gmail" | "github" | "news" | "edstem" | "moodle" | "outlook";
type LoginKey = "gmail" | "edstem" | "moodle" | "outlook";
type ServiceSetting = {
  key: ServiceKey;
  label: string;
  description: string;
  login: "oauth" | "browser" | null;
  loginConfigured: boolean;
};
type ServiceConnection = {
  state: "not_connected" | "connected" | "opening" | "awaiting_user" | "error" | "closed";
  connectedAt?: string;
  message?: string;
};
type SettingsPayload = {
  order: ServiceKey[];
  enabled: Record<ServiceKey, boolean>;
  services: ServiceSetting[];
  connections: Partial<Record<LoginKey, ServiceConnection>>;
};
type SettingsPreferences = Pick<SettingsPayload, "order" | "enabled">;
type SettingsProps = {
  settings: SettingsPayload;
  onSave: (preferences: SettingsPreferences) => Promise<SettingsPayload>;
  onStartLogin: (service: LoginKey) => Promise<{ settings: SettingsPayload; authorizationUrl?: string }>;
  onCompleteLogin: (service: LoginKey) => Promise<SettingsPayload>;
  onCancelLogin: (service: LoginKey) => Promise<SettingsPayload>;
};

const roots = new WeakMap<HTMLElement, Root>();

const rootFor = (id: string): Root | null => {
  const host = document.getElementById(id);
  if (!(host instanceof HTMLElement)) return null;
  let root = roots.get(host);
  if (!root) {
    root = createRoot(host);
    roots.set(host, root);
  }
  return root;
};

function MetricGrid({ metrics, unavailable, onNavigate }: {
  metrics: MetricSet | null;
  unavailable: boolean;
  onNavigate: (filter: string) => void;
}) {
  if (unavailable) {
    return <div className={styles.metricMessage}><Alert tone="danger" title="Saved activity is unavailable">Reconnect from the banner above to read your local metrics.</Alert></div>;
  }
  if (!metrics) {
    return <>
      {["Items", "Inbox", "Coursework", "Review"].map((label) => (
        <div className={styles.metricSkeleton} key={label}>
          <Skeleton label={`Loading ${label.toLowerCase()}`} lines={2} />
        </div>
      ))}
    </>;
  }

  const entries = [
    { label: "Items", value: metrics.total, context: "saved here", filter: "all", target: "Open all activity" },
    { label: "Inbox", value: metrics.emails, context: `${metrics.unread} unread`, filter: "email", target: "Open inbox" },
    { label: "Coursework", value: metrics.coursework, context: `across ${metrics.courses} course${metrics.courses === 1 ? "" : "s"}`, filter: "courses", target: "Open coursework" },
    { label: "Review", value: metrics.review, context: "waiting for your call", filter: "review", target: "Open review queue" },
  ];

  return entries.map((entry) => (
    <a
      key={entry.label}
      className={styles.metricLink}
      href="#stream-panel"
      aria-label={entry.target}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(entry.filter);
      }}
    >
      <MetricCard label={entry.label} value={entry.value} context={entry.context} />
    </a>
  ));
}

const activityColumns: DataColumn<ActivityRow>[] = [
  {
    key: "title",
    label: "Item",
    sortable: false,
    width: "45%",
    render: (_value, row) => (
      <div className={styles.itemCell}>
        <button className={styles.itemTitle} data-open-item={row.id} type="button" aria-label={`Open ${row.title}`}>
          {row.title}
        </button>
        {row.subtitle && <span className={styles.itemSubtitle}>{row.subtitle}</span>}
      </div>
    ),
  },
  { key: "source", label: "Source", width: "18%" },
  {
    key: "sortTime",
    label: "When",
    width: "19%",
    render: (_value, row) => <time dateTime={row.sortTime}>{row.when}</time>,
  },
  {
    key: "status",
    label: "Status",
    sortable: false,
    width: "18%",
    render: (_value, row) => <Badge tone={row.tone} size="sm">{row.status}</Badge>,
  },
];

function ActivityRegion({ state }: { state: ActivityState }) {
  if (state.kind === "loading") return <Skeleton label="Loading saved activity" lines={5} />;
  if (state.kind === "unavailable") {
    return (
      <Alert tone="danger" title="Local activity is unavailable">
        <span>Reconnect to browse saved items.</span>{" "}
        <Button variant="secondary" size="sm" type="button" onClick={state.retry}>Refresh activity</Button>
      </Alert>
    );
  }
  if (state.kind === "empty") {
    return (
      <EmptyState
        title={state.title}
        description={state.description}
        label="Activity results"
        action={state.clearFilters
          ? <Button variant="secondary" size="md" type="button" data-clear-filters>Clear filters</Button>
          : undefined}
      />
    );
  }
  return (
    <SortableDataTable
      rows={state.rows}
      rowKey="id"
      caption="Activity items"
      emptyMessage="No items match this view"
      defaultSort={{ key: "sortTime", direction: "desc" }}
      columns={activityColumns}
    />
  );
}

export function renderArcMetrics(metrics: MetricSet | null, unavailable: boolean, onNavigate: (filter: string) => void) {
  const root = rootFor("metric-grid");
  if (root) flushSync(() => root.render(<MetricGrid metrics={metrics} unavailable={unavailable} onNavigate={onNavigate} />));
}

export function renderArcActivity(state: ActivityState) {
  const root = rootFor("stream-table");
  if (root) flushSync(() => root.render(<ActivityRegion state={state} />));
}

export function renderArcRunButton(state: RunButtonState, onRun: () => void) {
  const root = rootFor("run-button-host");
  if (!root) return;
  flushSync(() => root.render(
    <Button
      id="run-button"
      type="button"
      variant="primary"
      size="md"
      aria-describedby="pulse-label"
      disabled={state.disabled && !state.loading}
      loading={state.loading}
      onClick={onRun}
    >
      {state.label}
    </Button>,
  ));
}

const loginStatusCopy: Record<ServiceConnection["state"], { label: string; tone: BadgeTone }> = {
  not_connected: { label: "Not connected", tone: "neutral" },
  connected: { label: "Connected", tone: "success" },
  opening: { label: "Opening sign-in", tone: "warning" },
  awaiting_user: { label: "Sign-in in progress", tone: "warning" },
  error: { label: "Needs attention", tone: "danger" },
  closed: { label: "Window closed", tone: "warning" },
};

const loginSetupHint = (service: LoginKey): string => service === "gmail"
  ? "Add OAuth client credentials in .gmail-credentials.json or set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET."
  : service === "moodle"
    ? "Set MOODLE_BASE_URL in your .env file before signing in."
    : "";

function SettingsPanel({ settings, onSave, onStartLogin, onCompleteLogin, onCancelLogin }: SettingsProps) {
  const preferencesKey = JSON.stringify([settings.order, settings.enabled]);
  const [order, setOrder] = useState(settings.order);
  const [enabled, setEnabled] = useState(settings.enabled);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const [loginBusy, setLoginBusy] = useState<LoginKey | "">("");
  const [loginError, setLoginError] = useState("");
  const [gmailAuthorizationUrl, setGmailAuthorizationUrl] = useState("");

  useEffect(() => {
    setOrder(settings.order);
    setEnabled(settings.enabled);
  }, [preferencesKey]);

  useEffect(() => {
    if (settings.connections.gmail?.state === "connected") {
      setGmailAuthorizationUrl("");
      setLoginError("");
    }
  }, [settings.connections.gmail?.state]);

  const dirty = JSON.stringify([order, enabled]) !== preferencesKey;
  const serviceByKey = new Map(settings.services.map((service) => [service.key, service]));

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaveState("saving");
    setSaveError("");
    try {
      await onSave({ order, enabled });
      setSaveState("saved");
    } catch (error) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "Could not save service settings.");
    }
  };

  const move = (key: ServiceKey, direction: -1 | 1) => {
    const current = order.indexOf(key);
    const next = current + direction;
    if (current < 0 || next < 0 || next >= order.length) return;
    const currentKey = order[current];
    const nextKey = order[next];
    if (currentKey === undefined || nextKey === undefined) return;
    const updated = [...order];
    updated[current] = nextKey;
    updated[next] = currentKey;
    setOrder(updated);
    setSaveState("idle");
  };

  const startLogin = async (service: LoginKey) => {
    setLoginBusy(service);
    setLoginError("");
    let popup: Window | null = null;
    if (service === "gmail") popup = window.open("about:blank", "morning-agent-gmail", "popup,width=520,height=760");
    try {
      const result = await onStartLogin(service);
      if (result.authorizationUrl) {
        if (popup) {
          popup.location.href = result.authorizationUrl;
          setGmailAuthorizationUrl("");
        } else {
          setGmailAuthorizationUrl(result.authorizationUrl);
          setLoginError("Your browser blocked the sign-in window. Open the Google sign-in link below.");
        }
      } else {
        popup?.close();
        setGmailAuthorizationUrl("");
      }
    } catch (error) {
      popup?.close();
      setLoginError(error instanceof Error ? error.message : "Could not start sign-in.");
    } finally {
      setLoginBusy("");
    }
  };

  const completeLogin = async (service: LoginKey) => {
    setLoginBusy(service);
    setLoginError("");
    try {
      await onCompleteLogin(service);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Could not finish sign-in.");
    } finally {
      setLoginBusy("");
    }
  };

  const cancelLogin = async (service: LoginKey) => {
    setLoginBusy(service);
    setLoginError("");
    if (service === "gmail") setGmailAuthorizationUrl("");
    try {
      await onCancelLogin(service);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Could not close the sign-in session.");
    } finally {
      setLoginBusy("");
    }
  };

  const connectionActions = (service: ServiceSetting) => {
    if (service.login === null) return <Badge tone="neutral" size="sm">{service.key === "github" ? "Token optional" : "No sign-in needed"}</Badge>;
    const key = service.key as LoginKey;
    const connection = settings.connections[key] ?? { state: "not_connected" as const };
    const status = loginStatusCopy[connection.state];
    const busy = loginBusy === key;
    if (!service.loginConfigured) {
      return <span className={styles.connectionNote}>{loginSetupHint(key)}</span>;
    }
    if (connection.state === "awaiting_user" && service.login === "browser") {
      return <div className={styles.connectionActions}>
        <Button type="button" variant="secondary" size="md" loading={busy} onClick={() => void completeLogin(key)}>Finish sign-in</Button>
        <Button type="button" variant="ghost" size="md" disabled={busy} onClick={() => void cancelLogin(key)}>Cancel sign-in</Button>
      </div>;
    }
    if (connection.state === "awaiting_user" && service.login === "oauth") {
      return <div className={styles.connectionActions}>
        <Button type="button" variant="secondary" size="md" disabled={busy} onClick={() => void cancelLogin(key)}>Cancel sign-in</Button>
      </div>;
    }
    return <Button type="button" variant="secondary" size="md" loading={busy} onClick={() => void startLogin(key)}>
      {connection.state === "connected" ? `Sign in to ${service.label} again` : `Sign in to ${service.label}`}
    </Button>;
  };

  return <div className={styles.settingsPage}>
    <header className={styles.settingsHeader}>
      <h1 id="settings-title">Settings</h1>
      <p>Choose which services Morning Agent checks, set their order, and sign in once before your first run.</p>
    </header>

    <div className={styles.settingsSections}>
      <form className={styles.settingsSection} onSubmit={save} aria-labelledby="services-title">
        <div className={styles.settingsSectionHeader}>
          <h2 id="services-title">Services and order</h2>
          <p>Enabled services run one at a time in this order.</p>
        </div>
        <ol className={styles.serviceGroup}>
          {order.map((key, index) => {
            const service = serviceByKey.get(key);
            if (!service) return null;
            return <li key={key} className={styles.serviceRow}>
              <span className={styles.servicePosition} aria-label={`Position ${index + 1}`}>{index + 1}</span>
              <div className={styles.serviceCopy}>
                <label className={styles.serviceToggle}>
                  <input
                    type="checkbox"
                    checked={enabled[key]}
                    onChange={(event) => {
                      setEnabled({ ...enabled, [key]: event.target.checked });
                      setSaveState("idle");
                    }}
                    aria-label={`Include ${service.label}`}
                    aria-describedby={`service-description-${key}`}
                  />
                  <span className={styles.serviceName}>{service.label}</span>
                </label>
                <p id={`service-description-${key}`}>{service.description}</p>
              </div>
              <div className={styles.orderControls}>
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  className={styles.orderButton}
                  disabled={index === 0}
                  aria-label={`Move ${service.label} earlier`}
                  onClick={() => move(key, -1)}
                ><ArrowUp size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  className={styles.orderButton}
                  disabled={index === order.length - 1}
                  aria-label={`Move ${service.label} later`}
                  onClick={() => move(key, 1)}
                ><ArrowDown size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
              </div>
            </li>;
          })}
        </ol>
        {saveState === "error" && <Alert tone="danger" title="Service settings were not saved">{saveError}</Alert>}
        <div className={styles.settingsActions}>
          <Button type="submit" variant="primary" size="md" loading={saveState === "saving"} disabled={!dirty && saveState !== "error"}>
            {saveState === "saved" ? "Saved" : "Save settings"}
          </Button>
        </div>
      </form>

      <section className={styles.settingsSection} aria-labelledby="connections-title">
        <div className={styles.settingsSectionHeader}>
          <h2 id="connections-title">Sign in to services</h2>
          <p>Sign in here first so runs can reuse your saved session.</p>
        </div>
        <ul className={styles.connectionGroup}>
          {settings.services.map((service) => {
            const connection = service.login === null ? undefined : settings.connections[service.key as LoginKey];
            const status = connection === undefined ? undefined : loginStatusCopy[connection.state];
            return <li key={service.key} className={styles.connectionRow}>
              <div className={styles.connectionCopy}>
                <div className={styles.connectionTitleRow}>
                  <h3>{service.label}</h3>
                  {status && <Badge tone={status.tone} size="sm">{status.label}</Badge>}
                </div>
                {connection?.state === "awaiting_user" && service.login === "browser"
                  ? <p>Sign in in the opened browser, then return here and choose Finish sign-in.</p>
                  : connection?.state === "awaiting_user" && service.login === "oauth"
                    ? <p>Approve read-only access in the Google tab. This page updates when sign-in finishes.</p>
                    : connection?.state === "error" || connection?.state === "closed"
                      ? <p>{connection.message ?? "Try signing in again."}</p>
                      : <p>{service.description}</p>}
              </div>
              <div className={styles.connectionControl}>{connectionActions(service)}</div>
            </li>;
          })}
        </ul>
        {loginError && <Alert tone="danger" title="Could not update sign-in">
          {loginError}{gmailAuthorizationUrl && <> <a className={styles.loginLink} href={gmailAuthorizationUrl} target="_blank" rel="noreferrer">Open Google sign-in</a></>}
        </Alert>}
      </section>
    </div>
  </div>;
}

export function renderArcSettings(props: SettingsProps) {
  const root = rootFor("settings-ui-host");
  if (root) flushSync(() => root.render(<SettingsPanel {...props} />));
}
