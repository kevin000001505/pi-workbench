async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  get: <T>(url: string) => call<T>("GET", url),
  post: <T>(url: string, body: unknown = {}) => call<T>("POST", url, body),
  put: <T>(url: string, body: unknown) => call<T>("PUT", url, body),
  patch: <T>(url: string, body: unknown) => call<T>("PATCH", url, body),
  del: <T>(url: string) => call<T>("DELETE", url),
};
