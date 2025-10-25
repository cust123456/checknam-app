// API/cdx.js
export default async function handler(req, res) {
  const { url, type = "first" } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url param" });

  // Chọn endpoint phù hợp
  let apiUrl = "";
  if (type === "first") {
    apiUrl = `https://web.archive.org/cdx/search/cdx?output=json&filter=statuscode:200&fl=timestamp&collapse=digest&limit=1&sort=ascending&url=${encodeURIComponent(url)}`;
  } else if (type === "last") {
    apiUrl = `https://web.archive.org/cdx/search/cdx?output=json&filter=statuscode:200&fl=timestamp&collapse=digest&limit=1&sort=descending&url=${encodeURIComponent(url)}`;
  } else if (type === "year") {
    apiUrl = `https://web.archive.org/cdx/search/cdx?output=json&fl=timestamp&collapse=timestamp:4&filter=statuscode:200&url=${encodeURIComponent(url)}`;
  } else {
    return res.status(400).json({ error: "Invalid type param" });
  }

  // Hàm sleep
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Thử lại tối đa 3 lần nếu bị lỗi mạng hoặc 429
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(apiUrl, { cache: "no-store" });
      if (response.status === 429) {
        console.warn(`CDX rate limited (${attempt}/3) for ${url}`);
        await sleep(1500 + Math.random() * 1500);
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      return res.status(200).json(data);
    } catch (e) {
      lastError = e;
      console.warn(`Fetch error attempt ${attempt} for ${url}:`, e);
      await sleep(1000 + Math.random() * 800);
    }
  }

  return res.status(500).json({
    error: "CDX fetch failed after retries",
    details: String(lastError),
  });
}
