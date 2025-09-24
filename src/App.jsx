import React, { useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Zap, Info, Download, Loader2, Play, Upload, X, CheckCircle2, AlertCircle,
} from "lucide-react";

/* ========= Utils ========= */
function parseDomains(input) {
  return Array.from(
    new Set(
      input
        .split(/\r?\n|,|\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/^(https?:\/\/)?(www\.)?/i, ""))
    )
  ).slice(0, 1000);
}

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
  const y = ts.slice(0, 4), m = ts.slice(4, 6), d = ts.slice(6, 8);
  const hh = ts.slice(8, 10), mm = ts.slice(10, 12), ss = ts.slice(12, 14);
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

/* ========= App ========= */
export default function App() {
  const [input, setInput] = useState("");
  const [items, setItems] = useState([]); // {domain, status, archived, url, timestamp, error}
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const abortRef = useRef(null);

  const domains = useMemo(() => parseDomains(input), [input]);
  const donePct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  const start = async () => {
    const list = parseDomains(input);
    if (list.length === 0) return;
    setIsRunning(true);
    setItems(list.map((d) => ({ domain: d, status: "queued" })));
    setProgress({ done: 0, total: list.length });

    const controller = new AbortController();
    abortRef.current = controller;

    // chạy theo “batch” 10 domain/lần để giống mô tả UI
    const BATCH = 10;
    let done = 0;

    for (let startIdx = 0; startIdx < list.length; startIdx += BATCH) {
      if (controller.signal.aborted) break;
      const batch = list.slice(startIdx, startIdx + BATCH);

      await Promise.all(
        batch.map(async (domain, j) => {
          const i = startIdx + j;
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
          }
        })
      );
    }

    setIsRunning(false);
  };

  const stop = () => {
    abortRef.current?.abort();
    setIsRunning(false);
  };

  const loadSamples = () => {
    const samples = [
      "example.com","example.org","example.net","google.com","facebook.com",
      "github.com","stackoverflow.com","reddit.com","wikipedia.org","youtube.com",
    ];
    setInput(samples.join("\n"));
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
    const csv = [header, ...rows]
      .map((r) => r.map((x) => `"${String(x || "").replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `archive-check-${Date.now()}.csv`;
    a.click();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-4 flex items-center justify-center gap-3">
            <Zap className="w-10 h-10 text-yellow-500" />
            High-Speed Archive Checker
          </h1>
          <p className="text-xl text-gray-600 max-w-3xl mx-auto">
            Ultra-fast domain archive checking tool. Process up to 1000 domains with 10 domains per batch and parallel processing for maximum speed.
          </p>
        </div>

        {/* Card */}
        <div className="rounded-lg border bg-white text-gray-900 shadow-sm max-w-6xl mx-auto">
          <div className="flex flex-col space-y-1.5 p-6">
            <h3 className="tracking-tight text-2xl font-semibold flex items-center">
              {/* Chart icon-looking title */}
              <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6 mr-3 text-blue-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 3v16a2 2 0 0 0 2 2h16" />
                <path d="M18 17V9" />
                <path d="M13 17V5" />
                <path d="M8 17v-3" />
              </svg>
              Quick Bulk Archive Check
            </h3>
            <p className="text-gray-500 text-lg">
              High-performance scanning: 10 domains per batch • Parallel processing • Production optimized • Error-handled
            </p>
          </div>

          <div className="p-6 pt-6 space-y-6">
            {/* Info banner */}
            <div className="flex items-center gap-2 text-sm text-blue-700 bg-blue-50 p-3 rounded-lg">
              <Info className="h-4 w-4 text-blue-600" />
              <p>
                <strong>High-Speed Mode:</strong> Enter up to 1000 domains. Optimized for production deployment with robust error handling.
              </p>
            </div>

            {/* Textarea */}
            <textarea
              className="flex w-full rounded-md border border-gray-200 bg-white px-3 py-2 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 min-h-[250px] text-sm font-mono"
              placeholder="Enter domains (one per line or comma-separated)&#10;Examples: example.com example.org example.net google.com github.com wikipedia.org"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />

            {/* Buttons */}
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="flex items-center gap-3">
                {isRunning ? (
                  <button
                    onClick={stop}
                    className="inline-flex items-center justify-center h-11 rounded-md bg-red-600 hover:bg-red-700 text-white px-6 py-3 text-lg"
                  >
                    <X className="mr-2 h-5 w-5" />
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={start}
                    disabled={domains.length === 0}
                    className="inline-flex items-center justify-center h-11 rounded-md bg-yellow-600 hover:bg-yellow-700 disabled:opacity-60 text-white px-6 py-3 text-lg"
                  >
                    <Play className="mr-2 h-5 w-5" />
                    Start High-Speed Scan
                  </button>
                )}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={loadSamples}
                  className="inline-flex items-center justify-center border border-gray-200 bg-white hover:bg-gray-50 h-10 px-4 rounded-md text-sm"
                >
                  <Upload className="mr-2 h-4 w-4" />
                  Load Sample Domains
                </button>
                <button
                  onClick={exportCSV}
                  className="inline-flex items-center justify-center border border-gray-200 bg-white hover:bg-gray-50 h-10 px-4 rounded-md text-sm"
                >
                  <Download className="mr-2 h-4 w-4" />
                  Export CSV
                </button>
              </div>
            </div>

            {/* Progress bar */}
            {progress.total > 0 && (
              <div className="space-y-1">
                <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full bg-gray-900" style={{ width: `${donePct}%` }} />
                </div>
                <div className="text-xs text-gray-500">{progress.done} / {progress.total} • {donePct}%</div>
              </div>
            )}

            {/* Results */}
            {items.length > 0 && (
              <div className="rounded-lg border bg-white overflow-hidden">
                <div className="grid grid-cols-6 gap-2 p-3 text-xs font-medium bg-gray-50 border-b">
                  <div className="col-span-2">Domain</div>
                  <div>Archived</div>
                  <div>Timestamp</div>
                  <div className="col-span-2">Archive URL</div>
                </div>
                <div className="max-h-[420px] overflow-auto divide-y">
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
                          {it.status === "error" && (
                            <span className="inline-flex items-center gap-1 text-red-600">
                              <AlertCircle size={16}/> error
                            </span>
                          )}
                          {(!it.status || it.status === "archived" || it.status === "not_found") && (
                            <span className={it.archived ? "inline-flex items-center gap-1 text-emerald-700" : "inline-flex items-center gap-1 text-gray-500"}>
                              {it.archived ? <CheckCircle2 size={16}/> : <AlertCircle size={16}/>}
                              {it.archived ? "yes" : "no"}
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-xs">{formatTs(it.timestamp)}</div>
                        <div className="col-span-2 truncate">
                          {it.url ? (
                            <a className="underline" href={it.url} target="_blank" rel="noreferrer">{it.url}</a>
                          ) : <span className="text-gray-400">—</span>}
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
