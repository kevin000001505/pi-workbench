/**
 * Plain-language explanations for model endpoint failures. Used by the server's Settings → Test
 * probe and by the browser when a session's model call fails, so both say the same thing.
 */

export type EndpointFailure = {
  url: string;
  status?: number;
  contentType?: string;
  body?: string;
  /** Network-level error message (connection refused, DNS, timeout). */
  error?: string;
  modelId?: string;
  /** Model IDs the endpoint listed, when known. */
  models?: string[];
};

export const looksLikeHtml = (text: string | undefined) => !!text && /<(!doctype\s+html|html|head|body|script)[\s>]/i.test(text);

/** Short excerpt of a reply body for display: tags stripped from HTML, whitespace collapsed. */
export function excerpt(body: string | undefined, max = 200) {
  if (!body) return "";
  const text = looksLikeHtml(body)
    ? `HTML page: ${body
        .replace(/<script[\s\S]*?<\/script>/gi, (sc) => (/location\.(href|replace)/.test(sc) ? " [script that redirects the browser to the site's root page] " : " [script] "))
        .replace(/<[^>]+>/g, " ")}`
    : body;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The most likely cause of a failed call, as one or two sentences the user can act on. */
export function explainFailure(f: EndpointFailure): string {
  const where = (() => {
    try {
      return new URL(f.url).host;
    } catch {
      return f.url;
    }
  })();
  if (f.error) {
    if (/abort|timeout|timed out/i.test(f.error)) {
      return `No reply from ${where} in time. The model may still be loading (llama-swap starts it on first use); try again in a minute.`;
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(f.error)) {
      return `The host ${where} doesn't resolve. Inside Docker, use host.docker.internal (the host) or the llama-swap container name, not localhost.`;
    }
    return `Nothing answered at ${where}. Check the base URL's host and port and that llama-swap is running. Inside Docker, localhost is the workbench container itself.`;
  }
  if (f.modelId && f.models && f.models.length > 0 && !f.models.includes(f.modelId)) {
    return `The endpoint doesn't serve "${f.modelId}". It lists: ${f.models.slice(0, 8).join(", ")}${f.models.length > 8 ? ", …" : ""}. Pick one on the Settings page.`;
  }
  if (looksLikeHtml(f.body) || (f.contentType ?? "").includes("text/html")) {
    return `${f.url} returned a web page${f.status ? ` (HTTP ${f.status})` : ""}, not a model API reply. Either the base URL points at the wrong service (or lacks /v1), or the server behind llama-swap doesn't answer this route. Try the same request against that server directly.`;
  }
  if (f.status === 401 || f.status === 403) return `The endpoint needs an API key: add LLM_API_KEY on the Secrets page.`;
  if (f.status === 404) return `${f.url} doesn't exist on that server, or it has no model by that name. The base URL usually ends in /v1.`;
  if (f.status && f.status >= 500) return `The model server failed (HTTP ${f.status}). Check llama-swap's logs and the model's own container logs.`;
  if (f.status) return `Unexpected HTTP ${f.status} from ${f.url}.`;
  return `The call to ${f.url} failed.`;
}

/**
 * pi reports a provider failure as "<status> <body>". When that body is a web page, return the
 * explanation to show instead of the raw HTML; otherwise null.
 */
export function explainModelError(message: string | undefined): string | null {
  if (!message || !looksLikeHtml(message)) return null;
  const status = /^\s*(\d{3})\b/.exec(message);
  const text = explainFailure({ url: "the model endpoint", status: status ? Number(status[1]) : undefined, body: message });
  return text.charAt(0).toUpperCase() + text.slice(1);
}
