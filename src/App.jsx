import React, { useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Zap, Download, Loader2, Upload, X, CheckCircle2, AlertCircle, ExternalLink, Copy
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
    throw new Error("Lỗi mạng");
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

// Hàm nâng cấp - retry nhiều lần, check đa dạng kiểu dữ liệu trả về, log lỗi rõ ràng
async function enrichByCDX(domain) {
  const fetchProxy = async (type) => {
    const url = `/api/cdx?url=${encodeURIComponent(domain)}&type=${type}`;
    for (let i = 0; i < 3; i++) { // thử tối đa 3 lần
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        if (data && ((Array.isArray(data) && data.length > 1) || (typeof data === "object" && Object.keys(data).length > 0))) {
          return data;
        }
      } catch (err) {
        // Có thể dùng Sentry, hoặc log ra console
        console.warn(`CDX API lỗi cho ${domain} (${type}):`, err);
      }
      await new Promise(r => setTimeout(r, 1000)); // đợi 1s giữa các lần thử
    }
    return null;
  };

  let firstYear = "—", lastYear = "—", years = "—", totalSnapshots = 0;

  const firstRes = await fetchProxy("first");
  if (Array.isArray(firstRes) && firstRes.length > 1 && firstRes[1][0]) {
    firstYear = firstRes[1][0].slice(0, 4);
  } else if (firstRes && firstRes.timestamp) {
    firstYear = firstRes.timestamp.slice(0, 4);
  }

  const lastRes = await fetchProxy("last");
  if (Array.isArray(lastRes) && lastRes.length > 1 && lastRes[1][0]) {
    lastYear = lastRes[1][0].slice(0, 4);
  } else if (lastRes && lastRes.timestamp) {
    lastYear = lastRes.timestamp.slice(0, 4);
  }

  if (firstYear !== "—" && lastYear !== "—") {
    const span = Number(lastYear) - Number(firstYear);
    years = `${span} năm`;
  }

  const yearRes = await fetchProxy("year");
  totalSnapshots = Array.isArray(yearRes)
    ? Math.max(0, yearRes.length - 1)
    : typeof yearRes === "object" && yearRes !== null
      ? Math.max(0, Object.keys(yearRes).length - 1)
      : 0;

  // Nếu vẫn chưa có dữ liệu, thử fetch trực tiếp từ Wayback API làm fallback
  if (totalSnapshots === 0) {
    // Có thể bổ sung logic fetch trực tiếp từ archive.org hoặc lưu log miền lỗi
  }

  return { firstYear, lastYear, years, totalSnapshots };
}

// Hàm quét song song
async function scanDomainsParallel(domains, setRows, setStats, setBatchInfo, abortRef, batchSize, delayBetweenAttempts, delayBetweenBatch) {
  setRows(domains.map(d => ({
    domain: d, status: "checking", years: "—", firstYear: "—", lastYear: "—", totalSnapshots: 0
  })));
  setStats({ done: 0, total: domains.length, errors: 0, avg: 0 });

  const controller = new AbortController();
  abortRef.current = controller;

  const batches = chunk(domains, batchSize);
  setBatchInfo({ idx: 1, total: batches.length });

  let done = 0;
  let errors = 0;
  let totalTime = 0;

  for (let b = 0; b < batches.length; b++) {
    setBatchInfo({ idx: b + 1, total: batches.length });
    const batch = batches[b];

    // Quét song song trong batch
    const promises = batch.map(async (domain, j) => {
      if (controller.signal.aborted) return;
      const globalIdx = b * batchSize + j;
      setRows(prev => {
        const c = [...prev];
        c[globalIdx] = { ...c[globalIdx], status: "checking", errorMsg: undefined };
        return c;
      });
      const t0 = performance.now();
      let result;
      for (let retry = 0; retry < 2; retry++) {
        try {
          // Quét available và enrich
          const res = await checkAvailable(domain);
          if (res.archived) {
            let enrichInfo = { years: "—", firstYear: "—", lastYear: "—", totalSnapshots: 0 };
            try {
              enrichInfo = await enrichByCDX(domain);
            } catch (err) {
              console.warn(`Lỗi enrich cho ${domain}:`, err);
            }
            result = { ...res, ...enrichInfo, status: "complete" };
            break; // thành công, break retry
          } else {
            result = { ...res, years: "—", firstYear: "—", lastYear: "—", totalSnapshots: 0, status: "complete" };
            break;
          }
        } catch (e) {
          if (retry === 1) {
            result = {
              status: "error",
              errorMsg: e?.message || "Lỗi không xác định",
              years: "—",
              firstYear: "—",
              lastYear: "—",
              totalSnapshots: 0,
              timeMs: 0,
              closestUrl: null,
              closestTs: null
            };
          }
          await new Promise(r => setTimeout(r, delayBetweenAttempts));
        }
      }
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
    });

    await Promise.allSettled(promises);
    if (controller.signal.aborted) break;
    if (b < batches.length - 1) await new Promise(r => setTimeout(r, delayBetweenBatch));
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

  // Có thể chỉnh nhanh/chậm ở đây
  const BATCH_SIZE = 10; // 10 domain mỗi batch
  const DELAY_BETWEEN_ATTEMPTS = 2500; // 2.5s chờ giữa 2 lần quét 1 domain
  const DELAY_BETWEEN_BATCH = 2500; // 2.5s chờ giữa các batch

  // Nâng cấp: quét song song
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
    a.download = `archive-ketqua-${Date.now()}.csv`;
    a.click();
  };

  const copyDomainsWithYears = () => {
    const lines = rows
      .filter(r => typeof r.years === "string" && r.years !== "—" && !r.years.startsWith("0"))
      .map(r => `${r.domain}, ${r.years}, ${r.firstYear}, ${r.lastYear}`);
    if (lines.length === 0) return;
    navigator.clipboard.writeText(lines.join("\n"));
  };

  const parsedCount = domains.length;
  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;

  const errorRows = rows.filter(r => r.status === "error");

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
            {isScanning ? "Đang Quét Nhanh..." : "Quét Nhanh"}
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
              Tải Miền Mẫu
            </button>
            <button
              onClick={exportCSV}
              className="inline-flex items-center justify-center border border-gray-200 bg-white hover:bg-gray-50 h-10 px-4 rounded-md text-sm"
            >
              <Download className="mr-2 h-4 w-4" />
              Xuất Kết Quả
            </button>
            <button
              onClick={copyDomainsWithYears}
              className="inline-flex items-center justify-center border border-gray-200 bg-white hover:bg-gray-50 h-10 px-4 rounded-md text-sm"
            >
              <Copy className="mr-2 h-4 w-4" />
              Coppy domain & năm
            </button>
          </div>
        </div>

        {isScanning && (
          <div className="p-4 border rounded-lg bg-white mb-4">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
              <span className="font-medium">
                Đang xử lý batch {batchInfo.idx} / {batchInfo.total}
              </span>
            </div>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden mt-3">
              <div className="h-full bg-black" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-xs text-gray-600 mt-2">
              10 miền mỗi lần quét • Mỗi miền quét 2 lần • Quét tuần tự từng batch (song song trong batch)
            </div>
            <div className="mt-2 text-sm flex items-center gap-4">
              <span className="text-emerald-600">✓ Đã hoàn thành: {stats.done - stats.errors}</span>
              <span className="text-red-600">✗ Lỗi: {stats.errors}</span>
              <span className="text-blue-700">⏱ TB: {isFinite(stats.avg) ? stats.avg : 0}ms</span>
              <button onClick={cancelScan} className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 bg-red-50 text-red-700 border border-red-200 rounded">
                <X className="h-4 w-4" /> Hủy Quét
              </button>
            </div>
          </div>
        )}

        <div className="bg-white border rounded-lg p-4 mb-4">
          <textarea
            className="w-full min-h-[160px] rounded-md border border-gray-200 p-3 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Dán bất cứ nội dung nào — hệ thống tự động tách miền hợp lệ (1 dòng, dấu phẩy hoặc cách đều được)"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
          <div className="text-xs text-gray-500 mt-2">
            Số miền đã tách: <b>{parsedCount}</b> (tối đa 1000)
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
              <span>Kết Quả Quét ({rows.length} miền)</span>
            </div>
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-gray-700">
                  <tr>
                    <th className="text-left px-4 py-2">Miền</th>
                    <th className="text-left px-4 py-2">Trạng thái</th>
                    <th className="text-left px-4 py-2">Số năm</th>
                    <th className="text-left px-4 py-2">Năm đầu</th>
                    <th className="text-left px-4 py-2">Năm cuối</th>
                    <th className="text-left px-4 py-2">Tổng bản lưu</th>
                    <th className="text-left px-4 py-2">Thời gian (ms)</th>
                    <th className="text-left px-4 py-2">Hành động</th>
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
                              <Loader2 className="animate-spin" size={16}/> Đang kiểm tra
                            </span>
                          )}
                          {r.status === "error" && (
                            <span className="inline-flex items-center gap-1 text-red-600">
                              <AlertCircle size={16}/> Lỗi
                              {r.errorMsg ? <span className="ml-2 text-xs">{r.errorMsg}</span> : null}
                            </span>
                          )}
                          {r.status === "complete" && (
                            <span className="inline-flex items-center gap-1 text-emerald-700">
                              <CheckCircle2 size={16}/> Hoàn thành
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
                                <ExternalLink size={14}/> Lưu trữ
                              </a>
                            ) : (
                              <span className="text-gray-400 px-3 py-1.5 border rounded-md">Lưu trữ</span>
                            )}
                          </div>
                        </td>
                      </motion.tr>
                    ))}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
            {errorRows.length > 0 && (
              <div className="mt-3 text-xs text-red-600">
                <b>Miền lỗi không lấy được dữ liệu:</b> {errorRows.map(r=>r.domain).join(", ")}
              </div>
            )}
          </div>
        )}

        <div className="text-xs text-neutral-500 pt-6">
          GENO TOOL Bản Quyền thuộc về GENO Ở KJC
        </div>
      </div>
    </div>
  );
}
