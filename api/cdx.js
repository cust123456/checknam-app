// Updated API route with concurrency limit, timeout, retry/backoff and 429 handling
const MAX_CONCURRENT = 4; // concurrency per server instance
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;

let active = 0;
const queue = [];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release() {
  active = Math.max(0, active - 1);
  if (queue.length > 0) {
    active++;
    const next = queue.shift();
    next();
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(apiUrl, options = {}) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 10000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(apiUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": options.userAgent || "checknam-app/1.0 (+https://your-site.example/)",
          Accept: "application/json",
        },
      });

      clearTimeout(timeout);

      if (resp.ok) {
        const text = await resp.text();
        try {
          return JSON.parse(text);
        } catch (e) {
          // invalid JSON
          throw new Error("Invalid JSON from upstream");
        }
      }

      // handle 429 specially: respect Retry-After if present
      if (resp.status === 429) {
        const ra = resp.headers.get("retry-after");
        const retryAfterMs = ra ? Number(ra) * 1000 : BASE_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`Upstream 429, attempt=${attempt}, retryAfterMs=${retryAfterMs}`, { apiUrl });
        await wait(retryAfterMs);
        continue; // retry
      }

      // for 5xx we retry with exponential backoff
      if (resp.status >= 500 && resp.status < 600) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`Upstream 5xx, attempt=${attempt}, backoff=${backoff}`, { apiUrl, status: resp.status });
        await wait(backoff);
        continue;
      }

      // other status -> capture body & return error info
      const body = await resp.text().catch(() => "");
      const err = new Error(`Upstream error ${resp.status}`);
      err.status = resp.status;
      err.body = body;
      throw err;
    } catch (e) {
      clearTimeout(timeout);
      // Abort/timeout -> retry a few times
      if (e.name === "AbortError") {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`Fetch timeout/abort, attempt=${attempt}, backoff=${backoff}`, { apiUrl });
        await wait(backoff);
        continue;
      }
      // other errors: if not last attempt, retry a bit
      if (attempt < MAX_RETRIES - 1) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`Fetch error, attempt=${attempt}, backoff=${backoff}`, { apiUrl, err: String(e) });
        await wait(backoff);
        continue;
      }
      // last attempt -> rethrow
      throw e;
    }
  }
  throw new Error("Exceeded retry attempts");
}

export default async function handler(req, res) {
  const { url, type = "first" } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url param" });

  // build apiUrl safely
  const base = "https://web.archive.org/cdx/search/cdx";
  const params = new URLSearchParams();
  params.set("output", "json");
  params.set("filter", "statuscode:200");
  params.set("fl", "timestamp");
  if (type === "first") {
    params.set("collapse", "digest");
    params.set("limit", "1");
    params.set("sort", "ascending");
  } else if (type === "last") {
    params.set("collapse", "digest");
    params.set("limit", "1");
    params.set("sort", "descending");
  } else if (type === "year") {
    params.set("collapse", "timestamp:4");
  } else {
    return res.status(400).json({ error: "Invalid type param" });
  }
  params.set("url", url);
  const apiUrl = `${base}?${params.toString()}`;

  await acquire();
  try {
    const data = await fetchWithRetry(apiUrl, { timeoutMs: 10000 });
    // normalize empty -> []
    if (!Array.isArray(data) || data.length === 0) return res.status(200).json([]);
    return res.status(200).json(data);
  } catch (e) {
    console.error("CDX handler error", { apiUrl, err: e });
    if (e.status) {
      return res.status(e.status).json({ error: e.message || "Upstream error", body: e.body ? String(e.body).slice(0, 2000) : undefined });
    }
    if (e.name === "AbortError") {
      return res.status(504).json({ error: "Upstream request timed out" });
    }
    return res.status(500).json({ error: "Fetch failed", details: String(e) });
  } finally {
    release();
  }
}
