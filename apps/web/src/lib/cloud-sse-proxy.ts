/** This endpoint has one fixed private upstream. Client input can select only a run and replay cursor. */
export async function proxyCloudRunEvents(
  request: Request,
  id: string,
): Promise<Response> {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
  )
    return Response.json(
      { error: "invalid_run", message: "A valid run is required." },
      { status: 400 },
    );
  const query = new URL(request.url).searchParams;
  if (
    [...query.keys()].some((key) => key !== "after") ||
    query.getAll("after").length > 1
  )
    return Response.json(
      { error: "invalid_cursor", message: "Choose a valid replay cursor." },
      { status: 400 },
    );
  const after = query.get("after");
  const lastEventId = request.headers.get("last-event-id");
  const validCursor = (value: string | null) =>
    value === null ||
    (/^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value)));
  if (!validCursor(after) || !validCursor(lastEventId))
    return Response.json(
      { error: "invalid_cursor", message: "Choose a valid replay cursor." },
      { status: 400 },
    );
  let upstream: URL;
  try {
    const base = new URL(
      process.env.LORI_API_INTERNAL_URL ?? "http://127.0.0.1:4000",
    );
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password
    )
      throw new Error("invalid_upstream");
    upstream = new URL(`/v1/work/cloud/runs/${id}/events`, base);
    if (after !== null) upstream.searchParams.set("after", after);
  } catch {
    return Response.json(
      { error: "stream_unavailable", message: "Live updates are unavailable." },
      { status: 503 },
    );
  }
  const headers = new Headers({
    Accept: "text/event-stream",
    "Accept-Encoding": "identity",
  });
  for (const name of [
    "cookie",
    "authorization",
    "last-event-id",
    "x-lori-protocol-version",
    "x-lori-project-id",
    "x-lori-project-client-version",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(upstream, {
      headers,
      signal,
      cache: "no-store",
      redirect: "manual",
    });
    clearTimeout(timeout);
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      const status = [401, 403, 404, 429].includes(response.status)
        ? response.status
        : 502;
      // Keep the API's refusal code (for example work_disabled) so the client can
      // tell Work being turned off from a lost session. Only a short, plain
      // identifier crosses; the rest of the upstream body is discarded.
      let error = "stream_unavailable";
      if (status !== 502) {
        try {
          const code = ((await response.json()) as { error?: unknown }).error;
          if (typeof code === "string" && /^[a-z][a-z_]{0,63}$/.test(code))
            error = code;
        } catch {
          // Not JSON: fall back to the generic code.
        }
      }
      await response.body?.cancel().catch(() => {});
      return Response.json(
        { error, message: "Live updates could not be connected." },
        { status },
      );
    }
    // Pass the stream itself through: reading text/arrayBuffer here buffers the entire response.
    // Cancelling this body cancels the fetch body, and the incoming request signal also aborts its connection.
    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "private, no-store, no-transform",
        "Content-Encoding": "identity",
        "X-Accel-Buffering": "no",
        Vary: "Cookie, Authorization",
      },
    });
  } catch {
    return Response.json(
      {
        error: "stream_unavailable",
        message: "Live updates could not be connected.",
      },
      { status: controller.signal.aborted ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
