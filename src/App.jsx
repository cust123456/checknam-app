import React, { useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Zap, Download, Loader2, Upload, X, CheckCircle2, AlertCircle, ExternalLink, Database
} from "lucide-react";

/* ============== Utils ============== */
// Lọc “bẩn” -> domain hợp lệ
function extractDomainsFromText(input) {
  if (!input) return [];
  const rough = input.split(/\r?\n|,|\s+/).map(s => s.trim()).filter(Boolean);
  const normalized = rough.map(tok => {
    try {
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(tok)) return tok.split("@")[1];
      if (/^https?:\/\//i.test(tok)) return new URL(tok).hostname;
      return tok;
    } catch { return tok; }
  });
  const strip = normalized.map(s =>
    s.replace(/^(https?:\/\/)?(www\.)?/i, "").replace(/[\/?#].*$/, "")
  );
  const domainRe = /^(?=.{1,253}$)(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.)+[a-z]{2,}$/i;
  return Array.from(new Set(strip.map(s => s.toLowerCase()))).filter(s => domainRe.test(s)).slice(0, 1000);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Wayback Available API (ổn định, nhanh)
async function checkAvailable(domain) {
  const endpoint = `https://archive.org/wayback/available?url=${encodeURIComponent(domain)}`;
  const t0 = performance.now();
  const res = await fetch(endpoint, { cache: "no-store" });
  const t1 = performance.now();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const closest = data?.archived_snapshots?.closest;
  return {
    archived: Boolean(closest),
    closestUrl: closest?.url || null,
    closestTs: closest?.timestamp || null,
    timeMs: Math.max(1, Math.round(t1 - t0)),
  };
}

// CDX: lấy first/last/năm-span + tổng snapshot theo NĂM (nhẹ)
async function enrichByCDX(domain) {
  // nhỏ giọt để tránh bị chặn
  await new Promise(r => setTimeout(r, 120));

  const firstLastBase = `https://web.archive.org/cdx/search/cdx?output=json&filter=statuscode:200&fl=timestamp&collapse=digest&url=${encodeURIComponent(domain)}`;
  const byYearUrl = `https://web.archive.org/cdx/search/cdx?output=json&fl=timestamp&collapse=timestamp:4&filter=statuscode:200&url=${encodeURIComponent(domain)}`;

  const [firstRes, lastRes, yearRes] = await Promise.allSettled([
    fetch(firstLastBase + "&limit=1&sort=ascending", { cache: "no-store" }),
    fetch(firstLastBase + "&limit=1&sort=descending", { cache: "no-store" }),
    fetch(byYearUrl, { cache: "no-store" }),
  ]);

  let firstYear = "—", lastYear = "—", years = "—", totalSnapshots = 0;

  if (firstRes.status === "fulfilled" && firstRes.value.ok) {
    const j = await firstRes.value.json();
    if (Array.isArray(j) && j.length > 1 && j[1][0]) firstYear = j[1][0].slice(0, 4);
  }
  if (lastRes.status === "fulfilled" && lastRes.value.ok) {
    const j = await lastRes.value.json();
    if (Array.isArray(j) && j.length > 1 && j[1][0]) lastYear = j[1][0].slice(0, 4);
  }
  if (firstYear !== "—" && lastYear !== "—") {
    const span = Number(lastYear) - Number(firstYear);
    years = `${span} years`;
  }
  if (yearRes.status === "fulfilled" && yearRes.value.ok) {
    const j = await yearRes.value.json();
    totalSnapshots = Math.max(0, (Array.isArray(j) ? j.length - 1 : 0));
  }

  return { firstYear, lastYear, years, totalSnapshots };
}

/* ============== App ============== */
export default function App() {
  const [raw, setRaw] = useState("");
  const domains = useMemo(() => extractDomainsFromText(raw), [raw]);

  const [rows, setRows] = useState([]); // {domain,status,timeMs,closestUrl,closestTs,years,firstYear,lastYear,totalSnapshots}
  const [isScanning, setIsScanning] = useState(false);
  const [batchInfo, setBatchInfo] = useState({ idx: 0, total: 0 });
  const [stats, setStats] = useState({ done: 0, total: 0, errors: 0, avg: 0 });
  const abortRef = useRef(null);

  // cấu hình batch
  const BATCH_SIZE = 10;

  const startScan = async () => {
    if (domains.length === 0) return;
    setIsScanning(true);
    setRows(domains.map(d => ({ domain: d, status: "checking", years: "—", firstYear: "—", lastYear: "—", totalSnapshots: 0 })));
    setStats({ done: 0, total: domains.length, errors: 0, avg: 0 });

    const controller = new AbortController();
    abortRef.current = controller;

    const batches = chunk(domains, BATCH_SIZE);
    setBatchInfo({ idx: 1, total: batches.length });

    let done = 0;
    let totalTime = 0;
    let errors = 0;

    for (let b = 0; b < batches.length; b++) {
      setBatchInfo({ idx: b + 1, total: batches.length });
      const batch = batches[b];

      // chạy song song trong batch (đủ nhanh, số lượng nhỏ)
      await Promise.all(
        batch.map(async (domain, j) => {
          if (controller.signal.aborted) return;
          const globalIdx = b * BATCH_SIZE + j;
          try {
            const res = await checkAvailable(domain);
            totalTime += res.timeMs;
            setRows(prev => {
              const c = [...prev];
              c[globalIdx] = {
                ...c[globalIdx],
                domain,
                status: "complete",
                timeMs: res.timeMs,
                closestUrl: res.closestUrl,
                closestTs: res.closestTs,
              };
              return c;
            });
          } catch (e) {
            errors += 1;
            setRows(prev => {
              const c = [...prev];
              c[globalIdx] = { ...c[globalIdx], domain, status: "error", timeMs: 0, closestUrl: null, closestTs: null };
              return c;
            });
          } finally {
            done += 1;
            setStats({ done, total: domains.length, errors, avg: Math.round(totalTime / Math.max(1, (done - errors))) });
          }
        })
      );

      if (controller.signal.aborted) break;
    }

    setIsScanning(false);
  };

  const cancelScan = () => {
    abortRef.current?.abort();
    setIsScanning(false);
  };

  const exportCSV = () => {
    const header = ["domain","status","years","first_year","last_year","total_snapshots","time_ms","closest_ts","archive_url"];
    const lines = [header.join(",")].concat(
      rows.map(r =>
        [
          r.domain,
          r.status,
          r.years ?? "",
          r.firstYear ?? "",
          r.lastYear ?? "",
          r.totalSnapshots ?? 0,
          r.timeMs ?? 0,
          r.closestTs ?? "",
          r.closestUrl ?? "",
        ].map(x => `"${String(x).replace(/"/g,'""')}"`).join(",")
      )
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `archive-results-${Date.now()}.csv`;
    a.click();
  };

  // Enrich từng dòng (CDX)
  const enrichOne = async (idx) => {
    const r = rows[idx];
    if (!r || r.status !== "complete") return;
    try {
      const info = await enrichByCDX(r.domain);
      setRows(prev => {
        const c = [...prev];
        c[idx] = { ...c[idx], ...info };
        return c;
      });
    } catch {
      // bỏ qua
    }
  };

  // Enrich tất cả (an toàn: chạy tuần tự)
  const enrichAllSafe = async () => {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]?.status === "complete") {
        // tránh block: delay nhỏ
        await enrichOne(i);
        await new Promise(r => setTimeout(r, 150));
      }
    }
  };

  const parsedCount = domains.length;
  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;

  return (
    <div className="min-h-screen bg-[#EEF2FF]">
      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* Controls row */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
          <button
            onClick={startScan}
            disabled={isScanning || parsedCount === 0}
            className="inline-flex items-center gap-2 bg-[#D19B00] hover:bg-[#B88700] text-white px-5 py-3 rounded-md text-base font-medium disabled:opacity-60"
          >
            <Zap className="w-5 h-5" />
            {isScanning ? "High-Speed Scanning..." : "High-Speed Scan"}
          </button>

          <div className="flex gap-3">
            <button
              onClick={() => {
                setRaw([
                  "map-apple.ru.com",
                  "com-payments.ru.com",
                  "r-tutu.ru.com",
                  "www-blablacar.ru.com",
                  "sale-avito.ru.com",
                  "paymentru.ru.com",
                ].join("\n"));
              }}
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
              Export Results
            </button>
          </div>
        </div>

        {/* Batch progress bar */}
        {isScanning && (
          <div className="p-4 border rounded-lg bg-white mb-4">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
              <span className="font-medium">
                Processing batch {batchInfo.idx} of {batchInfo.total}
              </span>
              <span className="text-gray-500">({(stats.done / Math.max(1, stats.total)).toFixed(1)} of 1.0s approx is just placeholder)</span>
            </div>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden mt-3">
              <div className="h-full bg-black" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-xs text-gray-600 mt-2">
              10 domains per batch • Parallel processing • High-speed mode
            </div>
            <div className="mt-2 text-sm flex items-center gap-4">
              <span className="text-emerald-600">✓ Completed: {stats.done - stats.errors}</span>
              <span className="text-red-600">✗ Errors: {stats.errors}</span>
              <span className="text-blue-700">⏱ Avg: {isFinite(stats.avg) ? stats.avg : 0}ms</span>
              <button onClick={cancelScan} className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 bg-red-50 text-red-700 border border-red-200 rounded">
                <X className="h-4 w-4" /> Cancel Scan
              </button>
            </div>
          </div>
        )}

        {/* Input */}
        <div className="bg-white border rounded-lg p-4 mb-4">
          <textarea
            className="w-full min-h-[160px] rounded-md border border-gray-200 p-3 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Paste anything — we auto-extract valid domains (1 per line, comma or spaces are OK)"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
          <div className="text-xs text-gray-500 mt-2">
            Parsed domains: <b>{parsedCount}</b> (max 1000)
          </div>
          {stats.total > 0 && (
            <div className="mt-3">
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full bg-black" style={{ width: `${pct}%` }} />
              </div>
              <div className="text-xs text-gray-600 mt-1">
                {stats.done} / {stats.total} • {pct}%
              </div>
            </div>
          )}
        </div>

        {/* Results */}
        {rows.length > 0 && (
          <div className="bg-white border rounded-lg">
            <div className="px-4 py-3 text-base font-semibold border-b flex items-center justify-between">
              <span>Scan Results ({rows.length} domains)</span>
              <button
                onClick={enrichAllSafe}
                className="inline-flex items-center gap-1 px-3 py-1.5 border rounded-md text-sm hover:bg-gray-50"
              >
                <Database size={14} /> Enrich All (safe)
              </button>
            </div>

            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-gray-700">
                  <tr>
                    <th className="text-left px-4 py-2">Domain</th>
                    <th className="text-left px-4 py-2">Status</th>
                    <th className="text-left px-4 py-2">Years</th>
                    <th className="text-left px-4 py-2">First Year</th>
                    <th className="text-left px-4 py-2">Last Year</th>
                    <th className="text-left px-4 py-2">Total Snapshots</th>
                    <th className="text-left px-4 py-2">Time (ms)</th>
                    <th className="text-left px-4 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <AnimatePresence initial={false}>
                    {rows.map((r, i) => (
                      <motion.tr key={r.domain} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="align-middle">
                        <td className="px-4 py-2 font-mono">{r.domain}</td>
                        <td className="px-4 py-2">
                          {r.status === "checking" && (
                            <span className="inline-flex items-center gap-1 text-gray-600"><Loader2 className="animate-spin" size={16}/> Checking</span>
                          )}
                          {r.status === "error" && (
                            <span className="inline-flex items-center gap-1 text-red-600"><AlertCircle size={16}/> Error</span>
                          )}
                          {r.status === "complete" && (
                            <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={16}/> Complete</span>
                          )}
                        </td>
                        <td className="px-4 py-2">{r.years ?? "—"}</td>
                        <td className="px-4 py-2">{r.firstYear ?? "—"}</td>
                        <td className="px-4 py-2">{r.lastYear ?? "—"}</td>
                        <td className="px-4 py-2">{r.totalSnapshots ?? 0}</td>
                        <td className="px-4 py-2">{r.timeMs ?? 0}</td>
                        <td className="px-4 py-2">
                          <div className="flex gap-2">
                            {r.closestUrl ? (
                              <a className="inline-flex items-center gap-1 px-3 py-1.5 border rounded-md hover:bg-gray-50"
                                 href={r.closestUrl} target="_blank" rel="noreferrer">
                                <ExternalLink size={14}/> Archive
                              </a>
                            ) : (
                              <span className="text-gray-400 px-3 py-1.5 border rounded-md">Archive</span>
                            )}
                            <button
                              onClick={() => enrichOne(i)}
                              disabled={r.status !== "complete"}
                              className="inline-flex items-center gap-1 px-3 py-1.5 border rounded-md hover:bg-gray-50 disabled:opacity-50"
                            >
                              <Database size={14}/> Enrich
                            </button>
                          </div>
                        </td>
                      </motion.tr>
                    ))}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="text-xs text-neutral-500 pt-6">
          Built with React · Tailwind · Framer Motion · Uses Wayback Available + CDX APIs
        </div>
      </div>
    </div>
  );
}
