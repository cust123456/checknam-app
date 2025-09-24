export default async function handler(req, res) {
  const { url, type = "first" } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url param" });

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

  try {
    const response = await fetch(apiUrl);
    const data = await response.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: "Fetch failed", details: String(e) });
  }
}
