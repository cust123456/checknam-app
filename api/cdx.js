export default async function handler(req, res) {
  const { url, type = "first" } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url param" });

  // Build URL with URL and URLSearchParams for safety
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
    // collapse by year
    params.set("collapse", "timestamp:4");
    // do not set limit to 1 for year — return all years
  } else {
    return res.status(400).json({ error: "Invalid type param" });
  }

  params.set("url", url);

  const apiUrl = `${base}?${params.toString()}`;

  try {
    // timeout handling
    const controller = new AbortController();
    const timeoutMs = 10000; // 10s
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        // helpful to set a UA so upstream doesn't block generic calls
        "User-Agent": "checknam-app/1.0 (+https://your-site.example/)",
        Accept: "application/json",
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      // try to capture response body for debugging
      let body = null;
      try {
        body = await response.text();
      } catch (e) {
        body = String(e);
      }
      console.error("CDX upstream error", { apiUrl, status: response.status, body });
      return res.status(response.status).json({
        error: "Upstream fetch failed",
        status: response.status,
        body: body ? String(body).slice(0, 2000) : null,
      });
    }

    // safe parse
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error("CDX invalid JSON", { apiUrl, text: text.slice(0, 2000) });
      return res.status(502).json({ error: "Invalid JSON from upstream", details: String(e) });
    }

    // normalize empty results to []
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(200).json([]);
    }

    return res.status(200).json(data);
  } catch (e) {
    console.error("CDX fetch exception", { apiUrl, err: e });
    if (e.name === "AbortError") {
      return res.status(504).json({ error: "Upstream request timed out" });
    }
    return res.status(500).json({ error: "Fetch failed", details: String(e) });
  }
}
