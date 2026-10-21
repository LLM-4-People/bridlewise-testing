const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
/**
 * The alert endpoints' page size. It is also the completeness threshold: a
 * page shorter than this is a final page, and a full page without a Link
 * header is ambiguous and refuses rather than passing as a whole population.
 */
const ALERT_PAGE_SIZE = 100;

function headers(token) {
  const value = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "bridlewise-floor-site",
  };
  if (token) value.Authorization = `Bearer ${token}`;
  return value;
}

/** The `Link` header as rel → URL. Absent or malformed, an empty map (the caller treats that as no marker). */
function parseLinkHeader(value) {
  const links = new Map();
  if (typeof value !== "string") return links;
  for (const part of value.split(",")) {
    const match = /<([^>]*)>\s*;\s*rel="([^"]+)"/u.exec(part.trim());
    if (match !== null) links.set(match[2], match[1]);
  }
  return links;
}

/** The `page` a pagination URL declares, or null when it is not a positive integer. */
function pageOf(url) {
  try {
    const page = Number(new URL(url, API_ROOT).searchParams.get("page"));
    return Number.isInteger(page) && page > 0 ? page : null;
  } catch {
    return null;
  }
}

/**
 * One API response with its pagination links. The Link header is the only
 * population-size marker the alert endpoints declare; a reader that throws it
 * away cannot tell a complete page from a truncated one.
 */
export async function requestPage(path, { token = null, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
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
  const linkHeader = typeof response.headers?.get === "function" ? response.headers.get("link") : null;
  return { body: await response.json(), links: parseLinkHeader(linkHeader) };
}

export async function requestJson(path, options) {
  return (await requestPage(path, options)).body;
}

export async function listRuns(
  repository,
  token = null,
  { fetchImpl = fetch, headSha = null } = {},
) {
  const query = headSha
    ? `?head_sha=${encodeURIComponent(headSha)}&per_page=100`
    : "?per_page=100";
  const data = await requestJson(
    `/repos/${repository}/actions/runs${query}`,
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

function openAlertsPath(repository, kind, page, perPage) {
  const endpoint = kind === "code-scanning" ? "code-scanning/alerts" : "dependabot/alerts";
  return `/repos/${repository}/${endpoint}?state=open&per_page=${perPage}&page=${page}`;
}

/**
 * The population size the API itself declares, or null when it declares none.
 *
 * The probe asks for one alert per page: the `rel="last"` page number IS the
 * number of open alerts, so the declared total is exact rather than inferred
 * from a full page. A one-alert page with no next link is a complete single
 * page under the API's pagination contract; any other headerless body (a
 * 100-item array returned for `per_page=1`) is a server that did not declare
 * its population and is refused.
 */
function declaredAlertTotal(probe) {
  const last = probe.links.get("last");
  if (last !== undefined) return pageOf(last);
  if (probe.links.has("next")) return null;
  if (probe.body.length === 0) return 0;
  if (probe.body.length === 1) return 1;
  return null;
}

/**
 * Open alerts with the facts completeness needs: how many the API declared,
 * how many were actually judged, and whether every page was seen. A truncated
 * population is reported as incomplete rather than counted as a smaller pass.
 */
export async function countOpenAlerts(repository, kind, token = null, { fetchImpl = fetch } = {}) {
  const probe = await requestPage(openAlertsPath(repository, kind, 1, 1), { token, fetchImpl });
  if (!Array.isArray(probe.body)) throw new Error(`the ${kind} alert endpoint returned no alert array`);
  const declaredTotal = declaredAlertTotal(probe);
  const alerts = [];
  let complete = declaredTotal !== null;
  if (declaredTotal !== null && declaredTotal > 0) {
    const pageCount = Math.ceil(declaredTotal / ALERT_PAGE_SIZE);
    for (let page = 1; page <= pageCount && complete; page += 1) {
      const result = await requestPage(openAlertsPath(repository, kind, page, ALERT_PAGE_SIZE), { token, fetchImpl });
      if (!Array.isArray(result.body)) throw new Error(`the ${kind} alert endpoint returned no alert array`);
      alerts.push(...result.body);
      const next = result.links.get("next");
      if (page < pageCount) {
        // A page that continues the population must declare the next one; a
        // full page with no marker is the truncation this refuses.
        complete = next !== undefined && pageOf(next) === page + 1;
      } else {
        // The terminal page must not declare a population larger than the
        // probe's declared total.
        complete = next === undefined;
      }
    }
    complete = complete && alerts.length === declaredTotal;
  }
  let high = 0;
  let critical = 0;
  for (const alert of alerts) {
    const severity = severityOf(kind, alert);
    if (severity === "high") high += 1;
    if (severity === "critical") critical += 1;
  }
  return {
    total: complete ? alerts.length : null,
    judged: alerts.length,
    declaredTotal,
    high,
    critical,
    complete,
    truncated: !complete,
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
