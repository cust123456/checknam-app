import React, { useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Zap, Download, Loader2, Play, Upload, X, CheckCircle2, AlertCircle, ExternalLink
} from "lucide-react";

/* ===================== Utils ===================== */
/** Lấy domain hợp lệ từ text lẫn URL/email */
function extractDomainsFromText(input) {
  if (!input) return [];
  // 1) tách sơ bộ theo khoảng trắng, xuống dòng, dấu phẩy
  const rough = input.split(/\r?\n|,|\s+/).map(s => s.trim()).filter(Boolean);

  // 2) chuẩn hoá: nếu là URL -> new URL để lấy hostname; nếu là email -> lấy phần sau @
  const normalized = rough.map(tok => {
    try {
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(tok)) {
        return tok.split("@")[1];
      }
      if (/^https?:\/\//i.test(tok)) {
        return new URL(tok).hostname;
      }
      return tok;
    } catch {
      return tok;
    }
  });

  // 3) loại bỏ tiền tố www., http..., slash, query...
  const strip = normalized.map(s =>
    s.replace(/^(https?:\/\/)?(www\.)?/i, "").replace(/[\/?#].*$/, "")
  );

  // 4) validate domain theo RFC-lite (label 1–63, tổng max 253)
  const domainRe = /^(?=.{1,253}$)(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.)+[a-z]{2,}$/i;

  const uniq = Array.from(new Set(strip))
    .map(s => s.toLowerCase())
    .filter(s => domainRe.test(s));

  return uniq.slice(0, 1000);
}

/** Available API: có snapshot gần nhất không */
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

/** CDX: lấy năm đầu & cuối nhanh (2 request nhẹ) */
async function fetchFirstLastYears(domain) {
  const base = `https://web.archive.org/cdx/search/cdx?output=json&filter=statuscode:200&fl=timestamp&collapse=digest&url=${encodeURIComponent(domain)}`;
  const [firstRes, lastRes] = await Promise.all([
    fetch(base + "&limit=1&sort=ascending", { cache: "no-store" }),
    fetch(base + "&limit=1&sort=descending", { cache: "no-store" }),
  ]);
  let firstYear = null, lastYear = null;
  if (firstRes.ok) {
    const j = await firstRes.json();
    if (Array.isArray(j) && j.length > 1 && j[1][0]) firstYear = j[1][0].slice(0, 4);
  }
  if (lastRes.ok) {
    const j = await lastRes.json();
    if (Array.isArray(j) && j.length > 1 && j[1][0]) lastYear = j[1][0].slice(0, 4);
  }
  let yearsSpan = null;
  if (firstYear && lastYear) {
    const span = Number(lastYear) - Number(firstYear);
    yearsSpan = `${span} years`;
  }
  return { firstYear, lastYear, yearsSpan };
}

/** CDX: đếm số snapshot theo năm (nhanh) */
async function fetchSnapshotsByYearCount(domain) {
  const url = `https://web.archive.org/cdx/search/cdx?output=json&fl=timestamp&collapse=timestamp:4&filter=statuscode:200&url=${encodeURIComponent(domain)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return 0;
  const j = await res.json();
  // j[0] là header; còn lại mỗi dòng là 1 "năm có snapshot"
  return Math.max(0, (Array.isArray(j) ? j.length - 1 : 0));
}

function formatTs(ts) {
  if (!ts) return "—";
  const y = ts.slice(0, 4), m = ts.slice(4, 6), d = ts.slice(6, 8);
  const hh = ts.slice(8, 10), mm = ts.slice(10, 12), ss = ts.slice(12, 14);
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

/** Chia mảng thành các part */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ===================== App ===================== */
export default function App() {
  const [raw, setRaw] = useState("");
  const domains = useMemo(() => extractDomainsFromText(raw), [raw]);

  const [rows, setRows] = useState([]); // {domain, status, years, firstYear, lastYear, totalSnapshots, timeMs, closestUrl, closestTs, error}
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const abortRef = useRef(null);

  // cấu hình batch & concurrency
  const PART_SIZE = 50;       // mỗi “part” 50 domain (bạn chỉnh tuỳ ý)
  const CONCURRENCY = 10;     // số request song song trong một part

  const startScan = async () => {
    const list = domains;
    if (list.length === 0) return;
    setIsRunning(true);
    setRows(list.map(d => ({ domain: d, status: "queued" })));
    setProgress({ done: 0, total: list.length });

    const controller = new AbortController();
    abortRef.current = controller;

    const parts = chunk(list, PART_SIZE);
    let done = 0;

    for (let p = 0; p < parts.length; p++) {
      if (controller.signal.aborted) break;
      const part = parts[p];

      // chạy theo “pool” concurrency
      let idxInPart = 0;
      async function worker() {
        while (idxInPart < part.length) {
          const localIdx = idxInPart++;
          const domain = part[localIdx];
          const globalIdx = p * PART_SIZE + localIdx;

          if (controller.signal.aborted) break;

          try {
            setRows(prev => {
              const c = [...prev]; c[globalIdx] = { ...c[globalIdx], status: "checking" }; return c;
            });

            // 1) available (archived + closest + time)
            const avail = await checkAvailable(domain);

            // 2) first/last year + span
            const { firstYear, lastYear, yearsSpan } = await fetchFirstLastYears(domain);

            // 3) count by year (nhẹ, gần giống “total snapshots” bạn cần)
            const totalSnapshots = await fetchSnapshotsByYearCount(domain);

            setRows(prev => {
              const c = [...prev];
              c[globalIdx] = {
                domain,
                status: "complete",
                years: yearsSpan ?? (avail.archived ? "—" : "0 years"),
                firstYear: firstYear ?? "—",
                lastYear: lastYear ?? "—",
                totalSnapshots,
                timeMs: avail.timeMs,
                closestUrl: avail.closestUrl,
                closestTs: avail.closestTs,
              };
              return c;
            });
          } catch (e) {
            setRows(prev => {
              const c = [...prev];
              c[globalIdx] = {
                domain,
                status: "error",
                years: "—",
                firstYear: "—",
                lastYear: "—",
                totalSnapshots: 0,
                timeMs: 0,
                closestUrl: null,
                closestTs: null,
                error: String(e),
              };
              return c;
            });
          } finally {
            done += 1;
            setProgress({ done, total: list.length });
          }
        }
      }

      // tạo pool CONCURRENCY
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, part.length) }, () => worker())
      );
    }

    setIsRunning(false);
  };

  const stopScan = () => {
    abortRef.current?.abort();
    setIsRunning(false);
  };

  const loadSamples = () => {
    const s = [
      "map-apple.ru.com",
      "com-payments.ru.com",
      "r-tutu.ru.com",
      "www-blablacar.ru.com",
      "sale-avito.ru.com",
      "paymentru.ru.com",
      "https://github.com/some/path?q=1",
      "mailto:test@example.com",
      "not-a-domain",
      "http://wikipedia.org/wiki/Wayback_Machine",
    ];
    setRaw(s.join("\n"));
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

  const completed = rows.filter(r => r.status === "complete").length;
  const errors = rows.filter(r => r.status === "error").length;
  const avgMs =
    rows.filter(r => r.timeMs > 0).reduce((s, r) => s + r.timeMs, 0) /
    Math.max(1, rows.filter(r => r.timeMs > 0).length);

  /* ===================== UI ===================== */
  return (
    <div className="min-h-screen bg-[#F3F6FF]">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-6">
          <button
            onClick={startScan}
            disabled={isRunning || domains.length === 0}
            className="inline-flex items-center gap-2 bg-[#D19B00] hover:bg-[#B88700] text-white px-5 py-3 rounded-md text-base font-medium disabled:opacity-60"
          >
            <Zap className="w-5 h-5" />
            Start High-Speed Scan
          </button>

          <div className="mt-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
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
                Export Results
              </button>
              {isRunning && (
                <button
                  onClick={stopScan}
                  className="inline-flex items-center justify-center border border-red-300 bg-red-50 hover:bg-red-100 text-red-700 h-10 px-4 rounded-md text-sm"
                >
                  <X className="mr-2 h-4 w-4" />
                  Stop
                </button>
              )}
            </div>

            {/* Summary bar giống ảnh mẫu */}
            <div className="flex items-center gap-4 bg-white border rounded-md px-4 py-2 text-sm">
              <span className="text-emerald-600">✓ Completed: {completed}</span>
              <span className="text-red-600">✗ Errors: {errors}</span>
              <span className="text-blue-700">⏱ Avg: {isFinite(avgMs) ? Math.round(avgMs) : 0}ms</span>
            </div>
          </div>
        </div>

        {/* Input area */}
        <div className="bg-white border rounded-lg p-4">
          <textarea
            className="w-full min-h-[180px] rounded-md border border-gray-200 p-3 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Paste anything — we will auto-extract valid domains (one per line, comma or spaces are OK)"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
          <div className="text-xs text-gray-500 mt-2">Parsed domains: <b>{domains.length}</b> (max 1000)</div>
          {progress.total > 0 && (
            <div className="mt-3">
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full bg-black" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
              </div>
              <div className="text-xs text-gray-600 mt-1">
                {progress.done} / {progress.total} • {Math.round((progress.done / progress.total) * 100)}%
              </div>
            </div>
          )}
        </div>

        {/* Results table */}
        {rows.length > 0 && (
          <div className="mt-6 bg-white border rounded-lg">
            <div className="px-4 py-3 text-base font-semibold border-b">Scan Results ({rows.length} domains)</div>
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
                    {rows.map((r) => (
                      <motion.tr
                        key={r.domain}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="align-middle"
                      >
                        <td className="px-4 py-2 font-mono">{r.domain}</td>
                        <td className="px-4 py-2">
                          {r.status === "checking" && (
                            <span className="inline-flex items-center gap-1 text-gray-600"><Loader2 className="animate-spin" size={16}/> Checking</span>
                          )}
                          {r.status === "queued" && <span className="text-gray-500">Queued</span>}
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
                          {r.closestUrl ? (
                            <a
                              className="inline-flex items-center gap-1 px-3 py-1.5 border rounded-md hover:bg-gray-50"
                              href={r.closestUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <ExternalLink size={14}/> Archive
                            </a>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
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
