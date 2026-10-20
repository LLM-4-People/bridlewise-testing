const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";

function headers(token) {
  const value = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "bridlewise-floor-site",
  };
  if (token) value.Authorization = `Bearer ${token}`;
  return value;
}

export async function requestJson(path, { token = null, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    headers: headers(token),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`GitHub API ${response.status} for ${path}${text ? `: ${text.slice(0, 160)}` : ""}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function listRuns(repository, token = null, { fetchImpl = fetch } = {}) {
  const data = await requestJson(
    `/repos/${repository}/actions/runs?per_page=100`,
    { token, fetchImpl },
  );
  return (data.workflow_runs ?? []).map((run) => ({
    id: run.id,
    name: run.name,
    path: run.path,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    headSha: run.head_sha,
    headBranch: run.head_branch,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    url: run.html_url,
  }));
}

export function latestByWorkflow(runs) {
  const latest = new Map();
  for (const run of runs) {
    const key = run.name || run.path || "unknown";
    const current = latest.get(key);
    if (!current || String(run.createdAt) > String(current.createdAt)) {
      latest.set(key, run);
    }
  }
  return latest;
}

function severityOf(kind, alert) {
  if (kind === "code-scanning") {
    return alert.rule?.security_severity_level ?? alert.rule?.severity ?? null;
  }
  return alert.security_advisory?.severity ?? null;
}

export async function countOpenAlerts(repository, kind, token = null, { fetchImpl = fetch } = {}) {
  const path =
    kind === "code-scanning"
      ? `/repos/${repository}/code-scanning/alerts?state=open&per_page=100`
      : `/repos/${repository}/dependabot/alerts?state=open&per_page=100`;
  const alerts = await requestJson(path, { token, fetchImpl });
  let high = 0;
  let critical = 0;
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    const severity = severityOf(kind, alert);
    if (severity === "high") high += 1;
    if (severity === "critical") critical += 1;
  }
  return {
    total: Array.isArray(alerts) ? alerts.length : 0,
    high,
    critical,
    truncated: Array.isArray(alerts) && alerts.length === 100,
  };
}

export async function listReleases(repository, token = null, { fetchImpl = fetch } = {}) {
  const releases = await requestJson(`/repos/${repository}/releases?per_page=20`, {
    token,
    fetchImpl,
  });
  return (Array.isArray(releases) ? releases : []).map((release) => ({
    tag: release.tag_name,
    name: release.name,
    draft: release.draft,
    prerelease: release.prerelease,
    publishedAt: release.published_at,
    url: release.html_url,
  }));
}

export function errorCode(error) {
  if (error?.status === 401 || error?.status === 403) return "authentication";
  if (error?.status === 404) return "unavailable";
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  return "api-error";
}
