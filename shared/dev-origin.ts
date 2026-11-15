/**
 * The one origin contract for the developer cockpit, its API and launcher.
 * An operator's exact origin wins; otherwise Codespaces declares its own
 * forwarded HTTPS origin. No provider credential or raw GitHub environment
 * needs to reach a child process to make local and forwarded startup agree.
 */
import { isLoopbackHostName } from "../engine/src/shared/outbound-http.ts";
import { DEV_CLIENT_PORT } from "./dev-ports.ts";

export const DEFAULT_DEV_ORIGIN = `http://127.0.0.1:${DEV_CLIENT_PORT}`;

type Environment = Readonly<Record<string, string | undefined>>;
export type DevOriginResolution = Readonly<
  | { ok: true; origin: string; source: "local" | "configured" | "codespaces"; forwardedHostname: string | undefined }
  | { ok: false; reason: string }
>;

function refused(name: string, expected: string): DevOriginResolution {
  // Never echo an invalid URL: it could contain userinfo or another secret.
  return Object.freeze({ ok: false, reason: `Invalid ${name}: expected ${expected}.` });
}

function resolved(origin: string, source: "local" | "configured" | "codespaces"): DevOriginResolution {
  const url = new URL(origin);
  return Object.freeze({ ok: true, origin: url.origin, source,
    forwardedHostname: isLoopbackHostName(url.hostname) ? undefined : url.hostname });
}

function dnsLabel(value: string): boolean {
  return value.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(value);
}

function dnsName(value: string): boolean {
  const labels = value.split(".");
  return value.length <= 253 && labels.length > 1 && labels.every(dnsLabel);
}

/** Resolve only explicit safe input; incomplete declared workspace metadata refuses boot. */
export function resolveDevOrigin(env: Environment): DevOriginResolution {
  const configured = env["HARNESS_WEB_ALLOWED_ORIGIN"];
  if (configured !== undefined && configured !== "") {
    const url = URL.parse(configured);
    if (url === null || !/^https?:\/\/[^/?#\\@\s]+\/?$/iu.test(configured) ||
        !["http:", "https:"].includes(url.protocol) ||
        url.username !== "" || url.password !== "" || url.hostname.startsWith(".") || url.pathname !== "/" ||
        url.search !== "" || url.hash !== "" || configured.trim() !== configured ||
        /[\\\u0000-\u0020\u007f]/u.test(configured)) {
      return refused("HARNESS_WEB_ALLOWED_ORIGIN", "one HTTP(S) origin without credentials, path, query or fragment");
    }
    return resolved(url.origin, "configured");
  }

  const name = env["CODESPACE_NAME"];
  const domain = env["GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN"];
  const declared = env["CODESPACES"] === "true" || name !== undefined || domain !== undefined;
  if (!declared) return resolved(DEFAULT_DEV_ORIGIN, "local");
  if (name === undefined || !dnsLabel(name)) return refused("CODESPACE_NAME", "one nonempty DNS label");
  if (domain === undefined || !dnsName(domain)) return refused("GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN", "a DNS domain without scheme, port or path");
  const hostname = `${name}-${DEV_CLIENT_PORT}.${domain}`;
  if (!dnsName(hostname)) return refused("Codespaces forwarded hostname", "a valid DNS hostname");
  return resolved(`https://${hostname}`, "codespaces");
}
