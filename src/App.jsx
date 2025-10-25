// src/App.jsx
import React, { useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, Download, Loader2, Upload, X, CheckCircle2, AlertCircle, ExternalLink, Copy } from "lucide-react";

// Tách domain hợp lệ
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Kiểm tra có snapshot không
async function checkAvailable(domain) {
  const endpoint = `https://archive.org/wayback/available?url=${encodeURIComponent(domain)}`;
  const t0 = performance.now();
  try {
    const res = await fetch(endpoint, { cache: "no-store" });
    const data = await res.json();
    const t1 = performance.now();
    const closest = data?.archived_snapshots?.closest;
    return {
      archived: Boolean(closest),
      closestUrl: closest?.url || null,
      closestTs: closest?.timestamp || null,
      timeMs: Math.round(t1 - t0),
    };
  } catch {
    throw new Error("Lỗi mạng hoặc API");
  }
}

// Gọi /api/cdx với retry
async function fetchCDX(domain, type) {
  const url = `/api/cdx?url=${encodeURIComponent(domain)}&type=${type}`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        await sleep(1500 + Math.random() * 1000);
        continue;
      }
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 1) return data;
    } catch {}
    await sleep(1000 + Math.random() * 500);
  }
  return null;
}

async function enrichByCDX(domain) {
  const firstRes = await fetchCDX(domain, "first");
  const lastRes = await fetchCDX(domain, "last");
  const yearRes = await fetchCDX(domain, "year");

  let firstYear = "—", lastYear = "—", years = "—", totalSnapshots = 0;
  if (Array.isArray(firstRes) && firstRes.length > 1) firstYear = firstRes[1][0].slice(0, 4);
  if (Array.isArray(lastRes) && lastRes.length > 1) lastYear = lastRes[1][0].slice(0, 4);
  if (Array.isArray(yearRes)) totalSnapshots = Math.max(0, yearRes.length - 1);

  if (firstYear !== "—" && lastYear !== "—") {
    years = `${Number(lastYear) - Number(firstYear)} năm`;
  }
  return { firstYear, lastYear, years, totalSnapshots };
}

// Quét theo batch 10 miền/lần
async function scanDomainsParallel(domains, setRows, setStats, setBatchInfo, abortRef, batchSize, delayBetweenAttempts, delayBetweenBatch) {
  setRows(domains.map(d => ({ domain: d, status: "checking" })));
  setStats({ done: 0, total: domains.length, errors: 0, avg: 0 });

  const controller = new AbortController();
  abortRef.current = controller;

  const batches = chunk(domains, batchSize);
  setBatchInfo({ idx: 1, total: batches.length });

  let done = 0, errors = 0, totalTime = 0;

  for (let b = 0; b < batches.length; b++) {
    setBatchInfo({ idx: b + 1, total: batches.length });
    const batch = batches[b];

    const promises = batch.map(async (domain, j) => {
      if (controller.signal.aborted) return;
      await sleep(150 + Math.random() * 400); // jitter nhỏ giữa domain
      const start = performance.now();

      try {
        const avail = await checkAvailable(domain);
        let enrich = { years: "—", firstYear: "—", lastYear: "—", totalSnapshots: 0 };
        if (avail.archived) enrich = await enrichByCDX(domain);

        const end = performance.now();
        done++;
        totalTime += end - start;

        setRows(prev => prev.map(r => (r.domain === domain ? { ...r, ...avail, ...enrich, status: "complete" } : r)));
      } catch (err) {
        done++;
        errors++;
        setRows(prev => prev.map(r => (r.domain === domain ? { ...r, status: "error", errorMsg: err.message } : r)));
      }

      setStats({ done, total: domains.length, errors, avg: Math.round(totalTime / Math.max(1, done - errors)) });
    });

    await Promise.allSettled(promises);

    if (controller.signal.aborted) break;

    // delay + jitter giữa batch
    if (b < batches.length - 1) {
      const jitter = 800 + Math.random() * 1200;
      await sleep(delayBetweenBatch + jitter);
    }
  }
}

export default function App() {
  const [raw, setRaw] = useState("");
  const domains = useMemo(() => extractDomainsFromText(raw), [raw]);
  const [rows, setRows] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [batchInfo, setBatchInfo] = useState({ idx: 0, total: 0 });
  const [stats, setStats] = useState({ done: 0, total: 0, errors: 0, avg: 0 });
  const abortRef = useRef(null);

  const BATCH_SIZE = 10;
  const DELAY_BETWEEN_ATTEMPTS = 2500;
  const DELAY_BETWEEN_BATCH = 3000;

  const startScan = async () => {
    if (domains.length === 0) return;
    setIsScanning(true);
    await scanDomainsParallel(domains, setRows, setStats, setBatchInfo, abortRef, BATCH_SIZE, DELAY_BETWEEN_ATTEMPTS, DELAY_BETWEEN_BATCH);
    setIsScanning(false);
  };

  const cancelScan = () => {
    abortRef.current?.abort();
    setIsScanning(false);
  };

  const exportCSV = () => {
    const header = ["domain","status","years","firstYear","lastYear","totalSnapshots","timeMs","closestTs","closestUrl"];
    const lines = [header.join(",")].concat(
      rows.map(r => header.map(h => JSON.stringify(r[h] ?? "")).join(","))
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `archive-result-${Date.now()}.csv`;
    a.click();
  };

  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;

  return (
    <div className="min-h-screen bg-[#EEF2FF]">
      <div className="max-w-6xl mx-auto px-4 py-6">
        <div className="flex flex-col md:flex-row justify-between gap-3 mb-4">
          <button
            onClick={startScan}
            disabled={isScanning || domains.length === 0}
            className="inline-flex items-center gap-2 bg-[#D19B00] hover:bg-[#B88700] text-white px-5 py-3 rounded-md font-medium disabled:opacity-60"
          >
            <Zap className="w-5 h-5" />
            {isScanning ? "Đang quét..." : "Bắt đầu quét"}
          </button>
          <button onClick={exportCSV} className="border bg-white px-4 py-2 rounded-md hover:bg-gray-50 flex items-center gap-2">
            <Download size={16} /> Xuất CSV
          </button>
        </div>

        {isScanning && (
          <div className="bg-white p-4 rounded-md mb-4 border">
            <Loader2 className="h-4 w-4 animate-spin inline-block mr-2 text-blue-600" />
            Đang xử lý batch {batchInfo.idx}/{batchInfo.total} ({pct}%)
          </div>
        )}

        <textarea
          className="w-full min-h-[150px] border p-3 rounded-md text-sm font-mono"
          placeholder="Dán danh sách domain, mỗi dòng một domain..."
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />

        {rows.length > 0 && (
          <div className="bg-white mt-4 p-4 rounded-md border overflow-auto">
            <table className="min-w-full text-sm">
              <thead><tr><th>Miền</th><th>Trạng thái</th><th>Số năm</th><th>Năm đầu</th><th>Năm cuối</th><th>Bản lưu</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.domain}>
                    <td>{r.domain}</td>
                    <td>{r.status}</td>
                    <td>{r.years}</td>
                    <td>{r.firstYear}</td>
                    <td>{r.lastYear}</td>
                    <td>{r.totalSnapshots}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
