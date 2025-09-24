import React, { useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Zap, Download, Loader2, Upload, X, CheckCircle2, AlertCircle, ExternalLink
} from "lucide-react";

// Lọc domain hợp lệ
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

// Wayback Available API
async function checkAvailable(domain) {
  const endpoint = `https://archive.org/wayback/available?url=${encodeURIComponent(domain)}`;
  const t0 = performance.now();
  let res, data;
  try {
    res = await fetch(endpoint, { cache: "no-store" });
    data = await res.json();
  } catch (e) {
    throw new Error("Network error");
  }
  const t1 = performance.now();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const closest = data?.archived_snapshots?.closest;
  return {
    archived: Boolean(closest),
    closestUrl: closest?.url || null,
    closestTs: closest?.timestamp || null,
    timeMs: Math.max(1, Math.round(t1 - t0)),
  };
}

async function enrichByCDX(domain) {
  const fetchProxy = async (type) => {
    const url = `/api/cdx?url=${encodeURIComponent(domain)}&type=${type}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };

  let firstYear = "—", lastYear = "—", years = "—", totalSnapshots = 0;

  const firstRes = await fetchProxy("first");
  if (Array.isArray(firstRes) && firstRes.length > 1 && firstRes[1][0]) {
    firstYear = firstRes[1][0].slice(0, 4);
  }

  const lastRes = await fetchProxy("last");
  if (Array.isArray(lastRes) && lastRes.length > 1 && lastRes[1][0]) {
    lastYear = lastRes[1][0].slice(0, 4);
  }

  if (firstYear !== "—" && lastYear !== "—") {
    const span = Number(lastYear) - Number(firstYear);
    years = `${span} years`;
  }

  const yearRes = await fetchProxy("year");
  totalSnapshots = Math.max(0, (Array.isArray(yearRes) ? yearRes.length - 1 : 0));

  return { firstYear, lastYear, years, totalSnapshots };
}

// Thử 2 lần cho 1 domain, lấy kết quả đầu tiên hợp lệ, trả về error nếu cả 2 lần đều fail
async function checkDomainTwice(domain, delayMs = 2500) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await checkAvailable(domain);
      if (res.archived) {
        let enrichInfo = { years: "—", firstYear: "—", lastYear: "—", totalSnapshots: 0 };
        try {
          enrichInfo = await enrichByCDX(domain);
        } catch {}
        return { ...res, ...enrichInfo, status: "complete" };
      }
      // Nếu không có archived, vẫn trả về complete với snapshot rỗng
      return { ...res, years: "—", firstYear: "—", lastYear: "—", totalSnapshots: 0, status: "complete" };
    } catch (e) {
      if (attempt === 2) {
        return {
          status: "error",
          errorMsg: e?.message || "Unknown error",
          years: "—",
          firstYear: "—",
          lastYear: "—",
          totalSnapshots: 0,
          timeMs: 0,
          closestUrl: null,
          closestTs: null
        };
      }
    }
    if (attempt === 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return {
    status: "error",
    errorMsg: "Unknown error",
    years: "—",
    firstYear: "—",
    lastYear: "—",
    totalSnapshots: 0,
    timeMs: 0,
    closestUrl: null,
    closestTs: null
  };
}

export default function App() {
  const [raw, setRaw] = useState("");
  const domains = useMemo(() => extractDomainsFromText(raw), [raw]);

  const [rows, setRows] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [batchInfo, setBatchInfo] = useState({ idx: 0, total: 0 });
  const [stats, setStats] = useState({ done: 0, total: 0, errors: 0, avg: 0 });
  const abortRef = useRef(null);

  // Có thể chỉnh nhanh/chậm ở đây
  const BATCH_SIZE = 10; // 10 domain mỗi batch
  const DELAY_BETWEEN_ATTEMPTS = 2500; // 2.5s chờ giữa 2 lần quét 1 domain
  const DELAY_BETWEEN_BATCH = 2500; // 2.5s chờ giữa các batch

  // Chạy từng batch, từng domain quét 2 lần, tuần tự batch
  const startScan = async () => {
    if (domains.length === 0) return;
    setIsScanning(true);
    setRows(domains.map(d => ({
      domain: d, status: "checking", years: "—", firstYear: "—", lastYear: "—", totalSnapshots: 0
    })));
    setStats({ done: 0, total: domains.length, errors: 0, avg: 0 });

    const controller = new AbortController();
    abortRef.current = controller;

    const batches = chunk(domains, BATCH_SIZE);
    setBatchInfo({ idx: 1, total: batches.length });

    let done = 0;
    let errors = 0;
    let totalTime = 0;

    for (let b = 0; b < batches.length; b++) {
      setBatchInfo({ idx: b + 1, total: batches.length });
      const batch = batches[b];
      for (let j = 0; j < batch.length; j++) {
        if (controller.signal.aborted) continue;
        const domain = batch[j];
        const globalIdx = b * BATCH_SIZE + j;
        setRows(prev => {
          const c = [...prev];
          c[globalIdx] = { ...c[globalIdx], status: "checking", errorMsg: undefined };
          return c;
        });
        const t0 = performance.now();
        const result = await checkDomainTwice(domain, DELAY_BETWEEN_ATTEMPTS);
        const t1 = performance.now();
        setRows(prev => {
          const c = [...prev];
          c[globalIdx] = {
            ...c[globalIdx],
            ...result,
            timeMs: result.status === "error" ? 0 : Math.max(1, Math.round(t1 - t0))
          };
          return c;
        });
        done += 1;
        if (result.status === "error") errors += 1;
        else totalTime += (result.timeMs || 0);
        setStats({ done, total: domains.length, errors, avg: Math.round(totalTime / Math.max(1, (done - errors))) });
      }
      if (controller.signal.aborted) break;
      if (b < batches.length - 1) await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCH));
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

  const parsedCount = domains.length;
  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;

  return (
    <div className="min-h-screen bg-[#EEF2FF]">
      <div className="max-w-6xl mx-auto px-4 py-6">
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

        {isScanning && (
          <div className="p-4 border rounded-lg bg-white mb-4">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
              <span className="font-medium">
                Processing batch {batchInfo.idx} of {batchInfo.total}
              </span>
            </div>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden mt-3">
              <div className="h-full bg-black" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-xs text-gray-600 mt-2">
              10 domains per batch • Each domain checked twice • Batch runs sequentially
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

        {rows.length > 0 && (
          <div className="bg-white border rounded-lg">
            <div className="px-4 py-3 text-base font-semibold border-b flex items-center justify-between">
              <span>Scan Results ({rows.length} domains)</span>
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
                            <span className="inline-flex items-center gap-1 text-gray-600">
                              <Loader2 className="animate-spin" size={16}/> Checking
                            </span>
                          )}
                          {r.status === "error" && (
                            <span className="inline-flex items-center gap-1 text-red-600">
                              <AlertCircle size={16}/> Error
                              {r.errorMsg ? <span className="ml-2 text-xs">{r.errorMsg}</span> : null}
                            </span>
                          )}
                          {r.status === "complete" && (
                            <span className="inline-flex items-center gap-1 text-emerald-700">
                              <CheckCircle2 size={16}/> Complete
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          {typeof r.years === "string" && /^\d+/.test(r.years) ? (
                            <span className={r.years.startsWith("0") ? "text-red-500 font-semibold" : "text-green-600 font-semibold"}>
                              {r.years}
                            </span>
                          ) : (r.years ?? "—")}
                        </td>
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

        <div className="text-xs text-neutral-500 pt-6">
          Built with React · Tailwind · Framer Motion · Uses Wayback Available + CDX APIs
        </div>
      </div>
    </div>
  );
}
