/** An error that maps directly onto an HTTP response for the browser. */
export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers;
  }
}

/**
 * Advice for a URL with a .local name such as umbrel.local, or null for any
 * other URL. Those names come from mDNS, which Docker containers cannot use,
 * so they are the usual reason the dashboard cannot reach a service.
 */
export function localNameHint(variable, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.hostname.toLowerCase().endsWith('.local')) return null;
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${variable} uses ${parsed.hostname}, and containers can't resolve .local names. `
    + `Use the IP address instead, such as http://192.168.1.10${port}.`;
}

/** The 502 for a service that did not answer at all. */
export function unreachableError(service, variable, url, err) {
  const advice = localNameHint(variable, url) ?? `Check ${variable}.`;
  return new HttpError(502, `Cannot reach ${service} (${err.cause?.code ?? err.name}). ${advice}`);
}
