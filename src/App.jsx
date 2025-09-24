import React, { useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Download, Loader2, Play, Upload, X, CheckCircle2, AlertCircle } from "lucide-react";

// --- Domain utils ---
function isValidHostname(h) {
  if (!h) return false;
  if (h.length > 253) return false;
  const labels = h.split(".");
  return labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

// Extract unique domains from arbitrary text/URLs/emails
function extractDomainsFromText(text) {
  if (!text) return [];
  const found = new Set();

  // Token pass (handles URLs, emails, plain hostnames)
  const tokens = text.split(/[\s,;]+/);
  for (const tokOrig of tokens) {
    let tok = tokOrig.trim();
    if (!tok) continue;

    // If it's an email, take the domain part
    const em = tok.match(/^[^@\s]+@([^@\s]+)$/);
    if (em) tok = em[1];

    // Strip protocol and leading www.
    tok = tok.replace(/^[a-z]+:\/\//i, "");
    tok = tok.replace(/^www\./i, "");

    // Cut off path, port, query, or fragment
    tok = tok.split(/[\/:?#]/)[0];

    // Trim leading/trailing non-domain characters
    tok = tok.replace(/^[^a-z0-9]+/gi, "");
    tok = tok.replace(/[^a-z0-9.-]+$/gi, "");

    tok = tok.toLowerCase().replace(/\.$/, "");
    if (isValidHostname(tok)) found.add(tok);
  }

  // Regex pass to catch bare domains inside long blobs
  const re = /(?:^|[^a-z0-9.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59}))(?=$|[^a-z0-9.-])/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let h = (m[1] || "").toLowerCase().replace(/\.$/, "");
    if (h.startsWith("www.")) h = h.slice(4);
    if (isValidHostname(h)) found.add(h);
  }

  return Array.from(found).slice(0, 1000);
}

// Backward-compat name used elsewhere in the component
const parseDomains = extractDomainsFromText;

// Wayback check
async function checkWayback(url) {
  const endpoint = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const res = await fetch(endpoint, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const closest = data?.archived_snapshots?.closest;
  return {
    archived: Boolean(closest),
    status: closest ? "archived" : "not_found",
    timestamp: closest?.timestamp || null,
    url: closest?.url || null,
    available: data?.url || url,
  };
}

function formatTs(ts) {
  if (!ts) return "—";
  const y = ts.slice(0, 4);
  const m = ts.slice(4, 6);
  const d = ts.slice(6, 8);
  const hh = ts.slice(8, 10);
  const mm = ts.slice(10, 12);
  const ss = ts.slice(12, 14);
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

export default function App() {
  const [input, setInput] = useState("");
  const [items, setItems] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [concurrency, setConcurrency] = useState(10);
  const abortRef = useRef(null);

  const domains = useMemo(() => parseDomains(input), [input]);

  const handleInputChange = (e) => {
    const cleaned = parseDomains(e.target.value);
    setInput(cleaned.join("\n"));
  };

  const handlePaste = (e) => {
    const text = e.clipboardData?.getData("text") || "";
    const cleaned = parseDomains(text);
    e.preventDefault();
    setInput(cleaned.join("\n"));
  };

  const start = async () => {
    const list = parseDomains(input);
    if (list.length === 0) return;
    setIsRunning(true);
    setItems(list.map((d) => ({ domain: d, status: "queued" })));
    setProgress({ done: 0, total: list.length });

    const controller = new AbortController();
    abortRef.current = controller;

    let idx = 0;
    let done = 0;

    const next = async () => {
      if (controller.signal.aborted) return;
      if (idx >= list.length) return;
      const i = idx++;
      const domain = list[i];
      try {
        setItems((prev) => {
          const copy = [...prev];
          copy[i] = { ...copy[i], status: "checking" };
          return copy;
        });
        const res = await checkWayback(domain);
        setItems((prev) => {
          const copy = [...prev];
          copy[i] = { domain, ...res };
          return copy;
        });
      } catch (e) {
        setItems((prev) => {
          const copy = [...prev];
          copy[i] = { domain, status: "error", error: String(e) };
          return copy;
        });
      } finally {
        done += 1;
        setProgress({ done, total: list.length });
        if (idx < list.length) await next();
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, () => next()));
    setIsRunning(false);
  };

  const stop = () => {
    abortRef.current?.abort();
    setIsRunning(false);
  };

  const loadSamples = () => {
    const samples = [
      "https://openai.com/blog",
      "example.com",
      "wikipedia.org/wiki/React_(web_framework)",
      "https://github.com/vitejs/vite",
      "mailto:abc@nytimes.com",
      "cnn.com/some/path?x=1",
      "web.archive.org",
      "nonexistent-domain-abc-xyz-123.tld",
    ];
    setInput(parseDomains(samples.join("\n")).join("\n"));
  };

  const clearAll = () => {
    setInput("");
    setItems([]);
    setProgress({ done: 0, total: 0 });
  };

  const exportCSV = () => {
    const header = ["domain", "archived", "status", "timestamp", "archive_url"];
    const rows = items.map((it) => [
      it.domain,
      it.archived ? "yes" : "no",
      it.status || (it.archived ? "archived" : "not_found"),
      it.timestamp || "",
      it.url || "",
    ]);
    const csv = [header, ...rows].map((r) => r.map((x) => `"${String(x || "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `archive-check-${Date.now()}.csv`;
    a.click();
  };

  const donePct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">High-Speed Archive Checker</h1>
            <p className="text-sm md:text-base text-neutral-600">
              Ultra-fast domain archive checking tool. Up to 1000 domains • {concurrency} concurrent checks • Parallel, reliable.
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={loadSamples} className="px-3 py-2 rounded-2xl border shadow-sm hover:shadow transition flex items-center gap-2">
              <Upload size={16}/>Load samples
            </button>
            {isRunning ? (
              <button onClick={stop} className="px-3 py-2 rounded-2xl border shadow-sm bg-red-50 hover:bg-red-100 transition flex items-center gap-2">
                <X size={16}/>Stop
              </button>
            ) : (
              <button onClick={start} className="px-3 py-2 rounded-2xl border shadow-sm bg-emerald-50 hover:bg-emerald-100 transition flex items-center gap-2">
                <Play size={16}/>Start
              </button>
            )}
          </div>
        </header>

        <section className="grid md:grid-cols-2 gap-6">
          <div className="space-y-3">
            <label className="text-sm font-medium">Domains (1 per line, max 1000)</label>
            <textarea
              className="w-full h-56 md:h-72 p-3 rounded-2xl border shadow-sm focus:outline-none focus:ring-2"
              placeholder={"Paste anything: URLs, emails, text…\nI will keep only unique valid domains."}
              value={input}
              onChange={handleInputChange}
              onPaste={handlePaste}
            />
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <div className="flex items-center gap-2">
                <span>Concurrency</span>
                <input type="range" min={1} max={20} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
                <span className="font-medium w-6 text-center">{concurrency}</span>
              </div>
              <span className="text-neutral-500">Parsed: {domains.length}</span>
              <button onClick={clearAll} className="text-neutral-700 underline">Clear</button>
              <button onClick={exportCSV} className="flex items-center gap-2 underline"><Download size={16}/>Export CSV</button>
            </div>

            <div className="mt-2">
              <div className="h-3 bg-neutral-200 rounded-full overflow-hidden">
                <div className="h-full bg-black" style={{ width: `${donePct}%` }} />
              </div>
              <div className="text-xs text-neutral-600 mt-1">{progress.done} / {progress.total} • {donePct}%</div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-neutral-600">
              <span>Status legend:</span>
              <span className="flex items-center gap-1"><CheckCircle2 size={16}/> archived</span>
              <span className="flex items-center gap-1"><AlertCircle size={16}/> not found / error</span>
            </div>
            <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
              <div className="grid grid-cols-6 gap-2 p-3 text-xs font-medium bg-neutral-50 border-b">
                <div className="col-span-2">Domain</div>
                <div>Archived</div>
                <div>Timestamp</div>
                <div className="col-span-2">Archive URL</div>
              </div>
              <div className="max-h-[460px] overflow-auto divide-y">
                <AnimatePresence initial={false}>
                  {items.map((it) => (
                    <motion.div
                      key={it.domain}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="grid grid-cols-6 gap-2 p-3 text-sm items-center"
                    >
                      <div className="col-span-2 font-mono truncate" title={it.domain}>{it.domain}</div>
                      <div>
                        {it.status === "checking" && (
                          <span className="inline-flex items-center gap-1"><Loader2 className="animate-spin" size={16}/> checking</span>
                        )}
                        {it.status === "queued" && <span>queued</span>}
                        {it.status === "error" && <span className="inline-flex items-center gap-1 text-red-600"><AlertCircle size={16}/> error</span>}
                        {(!it.status || it.status === "archived" || it.status === "not_found") && (
                          <span className={it.archived ? "inline-flex items-center gap-1 text-emerald-700" : "inline-flex items-center gap-1 text-neutral-500"}>
                            {it.archived ? <CheckCircle2 size={16}/> : <AlertCircle size={16}/>}
                            {it.archived ? "yes" : "no"}
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-xs">{formatTs(it.timestamp)}</div>
                      <div className="col-span-2 truncate">
                        {it.url ? (
                          <a className="underline" href={it.url} target="_blank" rel="noreferrer">{it.url}</a>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </section>

        <footer className="text-xs text-neutral-500 pt-4">
          Built with React • Tailwind • Framer Motion • Uses public Wayback API (archive.org/wayback/available)
        </footer>
      </div>
    </div>
  );
}
