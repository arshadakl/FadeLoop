export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfter?: string | null,
  ) {
    super(message);
  }
}
export async function request(
  path: string,
  options: RequestInit = {},
  session = true,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, { ...options, credentials: "same-origin" });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError(
      "Unable to connect. Check your connection and try again.",
      0,
    );
  }
  if (response.status === 401 && session)
    window.dispatchEvent(new Event("fadeloop:session-ended"));
  if (!response.ok) {
    let message = `Request failed (${response.status}). Please try again.`;
    try {
      const data = await response.json();
      if (typeof data.error === "string") message = data.error;
    } catch {}
    if (response.status === 401 && session)
      message = "Your session has ended. Please sign in again.";
    if (response.status === 429)
      message = `Too many attempts. Try again in ${Math.max(1, Math.ceil(Number(response.headers.get("retry-after") || 900) / 60))} minutes.`;
    throw new ApiError(
      message,
      response.status,
      response.headers.get("retry-after"),
    );
  }
  return response;
}
export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    session?: boolean;
  } = {},
): Promise<T> {
  const response = await request(
    path,
    {
      method: options.method || "GET",
      signal: options.signal,
      headers:
        options.body !== undefined
          ? { "content-type": "application/json" }
          : undefined,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    },
    options.session ?? true,
  );
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(
      "The server returned an unreadable response. Please try again.",
      response.status,
    );
  }
}
