import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Printer,
  Download,
  FileText,
  Image as ImageIcon,
  Lock,
  Clock,
  RefreshCw,
  Layers,
  Search,
  Sparkles,
  CheckCircle2,
  CheckCheck,
  Cpu,
  Trash2,
  Settings,
  X
} from 'lucide-react';

interface DocumentMetadata {
  id: string;
  original_filename: string;
  normalized_path: string;
  page_count: number;
  print_mode: 'SIMPLEX' | 'DUPLEX';
  is_encrypted: boolean;
  is_corrupted: boolean;
}

interface SessionState {
  session_id: string;
  customer_phone: string;
  status: 'RECEIVING' | 'READY' | 'SPOOLING' | 'COMPLETED' | 'PURGED';
  documents: DocumentMetadata[];
  created_at: number;
  last_activity_at: number;
  total_sheets: number;
}

interface PricingConfig {
  rate_simplex: number;
  rate_duplex: number;
}

const LOCAL_BRIDGE_URL = 'https://writing-cooperative-naval-jersey.trycloudflare.com';

export const OperatorDashboard: React.FC = () => {
  const API_BASE = useMemo(() => {
    return (import.meta as any).env?.VITE_API_URL || `http://${window.location.hostname}:8000`;
  }, []);

  const WS_BASE = useMemo(() => {
    return API_BASE.replace(/^http/, 'ws');
  }, [API_BASE]);

  const [sessions, setSessions] = useState<Record<string, SessionState>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'ACTIVE' | 'COMPLETED'>('ACTIVE');

  // Adjustable Pricing Rate Card State
  const [pricing, setPricing] = useState<PricingConfig>({ rate_simplex: 2.0, rate_duplex: 3.0 });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [editSimplex, setEditSimplex] = useState('2.00');
  const [editDuplex, setEditDuplex] = useState('3.00');

  const [availablePrinters, setAvailablePrinters] = useState<string[]>([]);
  const [selectedPrinter, setSelectedPrinter] = useState('');
  const [autoPrint, setAutoPrint] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isBridgeOnline, setIsBridgeOnline] = useState(false);
  const [isSpooling, setIsSpooling] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<WebSocket | null>(null);

  // Initial Fetch: Printers & Pricing Rates
  useEffect(() => {
    const detectPrinters = async () => {
      try {
        const bridgeRes = await fetch(`${LOCAL_BRIDGE_URL}/printers`, { signal: AbortSignal.timeout(1500) });
        if (bridgeRes.ok) {
          const bridgeData = await bridgeRes.json();
          if (bridgeData.printers && bridgeData.printers.length > 0) {
            setAvailablePrinters(bridgeData.printers);
            setSelectedPrinter(bridgeData.default || bridgeData.printers[0]);
            setIsBridgeOnline(true);
            return;
          }
        }
      } catch {
        setIsBridgeOnline(false);
      }

      try {
        const cloudRes = await fetch(`${API_BASE}/api/v1/printers`);
        const cloudData = await cloudRes.json();
        if (cloudData.printers && cloudData.printers.length > 0) {
          setAvailablePrinters(cloudData.printers);
          setSelectedPrinter(cloudData.default || cloudData.printers[0]);
        }
      } catch {
        setAvailablePrinters(['Default System Printer']);
        setSelectedPrinter('Default System Printer');
      }
    };

    detectPrinters();

    fetch(`${API_BASE}/api/v1/settings/pricing`)
      .then((res) => res.json())
      .then((data) => {
        setPricing(data);
        setEditSimplex(data.rate_simplex.toFixed(2));
        setEditDuplex(data.rate_duplex.toFixed(2));
      })
      .catch(() => {});

    fetch(`${API_BASE}/api/v1/settings/auto-print`)
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.auto_print === 'boolean') {
          setAutoPrint(data.auto_print);
        }
      })
      .catch(() => {});
  }, [API_BASE]);

  // WebSocket Live Stream
  useEffect(() => {
    const wsUrl = `${WS_BASE}/ws/operator`;
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => setIsConnected(false);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.event === 'INITIAL_SNAPSHOT') {
          const map: Record<string, SessionState> = {};
          msg.payload.forEach((s: SessionState) => {
            map[s.session_id] = s;
          });
          setSessions(map);
          if (msg.payload.length > 0 && !selectedSessionId) {
            setSelectedSessionId(msg.payload[0].session_id);
          }
          if (msg.pricing) {
            setPricing(msg.pricing);
            setEditSimplex(msg.pricing.rate_simplex.toFixed(2));
            setEditDuplex(msg.pricing.rate_duplex.toFixed(2));
          }
        } else if (msg.event === 'SESSION_UPDATED') {
          const updated: SessionState = msg.payload;
          setSessions((prev) => ({ ...prev, [updated.session_id]: updated }));
          setSelectedSessionId((curr) => curr || updated.session_id);
        } else if (msg.event === 'SESSION_PURGED') {
          const purgedId = msg.payload.session_id;
          setSessions((prev) => {
            const next = { ...prev };
            delete next[purgedId];
            return next;
          });
          setSelectedSessionId((curr) => (curr === purgedId ? null : curr));
        } else if (msg.event === 'PRICING_UPDATED') {
          setPricing(msg.payload);
          setEditSimplex(msg.payload.rate_simplex.toFixed(2));
          setEditDuplex(msg.payload.rate_duplex.toFixed(2));
        } else if (msg.event === 'AUTO_PRINT_TOGGLED') {
          setAutoPrint(msg.payload.auto_print);
        }
      } catch (err) {
        console.error('Socket decoding error:', err);
      }
    };

    return () => ws.close();
  }, [WS_BASE, selectedSessionId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== searchInputRef.current) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === 'Escape' && activeSession && !isSettingsOpen) {
        e.preventDefault();
        handleCompleteSession(activeSession.session_id);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const handleSavePricing = async () => {
    const payload: PricingConfig = {
      rate_simplex: parseFloat(editSimplex) || 2.0,
      rate_duplex: parseFloat(editDuplex) || 3.0
    };
    try {
      await fetch(`${API_BASE}/api/v1/settings/pricing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      setIsSettingsOpen(false);
    } catch (err) {
      alert(`Failed to save pricing: ${err}`);
    }
  };

  const handleToggleAutoPrint = async () => {
    const nextState = !autoPrint;
    setAutoPrint(nextState);
    try {
      await fetch(
        `${API_BASE}/api/v1/settings/auto-print?enabled=${nextState}&target_printer=${encodeURIComponent(selectedPrinter)}`,
        { method: 'POST' }
      );
    } catch (err) {
      console.error('Failed to toggle auto-print:', err);
    }
  };

  const handleCompleteSession = async (sessionId: string) => {
    try {
      await fetch(`${API_BASE}/api/v1/sessions/${sessionId}/complete`, {
        method: 'POST'
      });
      const nextRemaining = Object.values(sessions).filter(
        (s) => s.session_id !== sessionId && s.status !== 'COMPLETED'
      );
      if (nextRemaining.length > 0) {
        setSelectedSessionId(nextRemaining[0].session_id);
      }
    } catch (err) {
      console.error('Failed to complete session:', err);
    }
  };

  const handleClearAllCompleted = async () => {
    try {
      await fetch(`${API_BASE}/api/v1/sessions/clear-completed`, {
        method: 'POST'
      });
    } catch (err) {
      console.error('Failed to clear completed sessions:', err);
    }
  };

  const sessionList = useMemo(() => {
    return Object.values(sessions).sort((a, b) => b.last_activity_at - a.last_activity_at);
  }, [sessions]);

  const activeSessionsList = useMemo(() => {
    return sessionList.filter((s) => s.status !== 'COMPLETED');
  }, [sessionList]);

  const completedSessionsList = useMemo(() => {
    return sessionList.filter((s) => s.status === 'COMPLETED');
  }, [sessionList]);

  const displayedList = useMemo(() => {
    const list = activeTab === 'ACTIVE' ? activeSessionsList : completedSessionsList;
    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase();
    return list.filter(
      (s) =>
        s.customer_phone.toLowerCase().includes(q) ||
        s.session_id.toLowerCase().includes(q)
    );
  }, [activeTab, activeSessionsList, completedSessionsList, searchQuery]);

  const activeSession = selectedSessionId
    ? sessions[selectedSessionId]
    : displayedList[0] || null;

  const handleModeChange = (docId: string, mode: 'SIMPLEX' | 'DUPLEX') => {
    if (!activeSession) return;
    setSessions((prev) => {
      const s = prev[activeSession.session_id];
      if (!s) return prev;
      const updatedDocs = s.documents.map((d) => (d.id === docId ? { ...d, print_mode: mode } : d));
      return { ...prev, [s.session_id]: { ...s, documents: updatedDocs } };
    });
  };

  const handleGlobalModeOverride = (mode: 'SIMPLEX' | 'DUPLEX') => {
    if (!activeSession) return;
    setSessions((prev) => {
      const s = prev[activeSession.session_id];
      if (!s) return prev;
      const updatedDocs = s.documents.map((d) => ({ ...d, print_mode: mode }));
      return { ...prev, [s.session_id]: { ...s, documents: updatedDocs } };
    });
  };

  const handleDownloadMaster = () => {
    if (!activeSession) return;
    const url = `${API_BASE}/api/v1/sessions/${activeSession.session_id}/download`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `PrintFlow_${activeSession.session_id.slice(0, 8)}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handlePrintDirect = async () => {
    if (!activeSession) return;
    setIsSpooling(true);
    try {
      if (isBridgeOnline) {
        const pdfDownloadUrl = `${API_BASE}/api/v1/sessions/${activeSession.session_id}/download`;
        const res = await fetch(`${LOCAL_BRIDGE_URL}/spool?pdf_url=${encodeURIComponent(pdfDownloadUrl)}&printer_name=${encodeURIComponent(selectedPrinter)}`, {
          method: 'POST'
        });
        if (!res.ok) throw new Error('Local bridge failed to dispatch job to Windows driver.');
      } else {
        await fetch(
          `${API_BASE}/api/v1/sessions/${activeSession.session_id}/dispatch`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'PRINT_DIRECT',
              target_printer: selectedPrinter,
              tray_bin: 'Auto',
              document_overrides: activeSession.documents.map((d) => ({
                document_id: d.id,
                print_mode: d.print_mode
              }))
            })
          }
        );
      }
    } catch (err) {
      alert(`Print error: ${err}`);
    } finally {
      setTimeout(() => setIsSpooling(false), 800);
    }
  };

  // Live Sheet Count & Dynamic Bill Calculation
  const sheetSummary = useMemo(() => {
    if (!activeSession) return { singleCount: 0, doubleSheets: 0, totalSheets: 0, estimatedCost: 0 };
    let singleCount = 0;
    let doublePages = 0;

    activeSession.documents.forEach((d) => {
      if (d.is_corrupted) return;
      if (d.print_mode === 'SIMPLEX') {
        singleCount += d.page_count;
      } else {
        const padded = d.page_count + (d.page_count % 2 !== 0 ? 1 : 0);
        doublePages += padded;
      }
    });

    const doubleSheets = Math.ceil(doublePages / 2);
    const totalSheets = singleCount + doubleSheets;
    const estimatedCost = (singleCount * pricing.rate_simplex) + (doubleSheets * pricing.rate_duplex);

    return { singleCount, doubleSheets, totalSheets, estimatedCost };
  }, [activeSession, pricing]);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden select-none font-sans bg-[#070A11] text-slate-100">
      
      {/* Top Navbar (Cleaned: No shift counters) */}
      <header className="h-16 px-6 border-b flex items-center justify-between shrink-0 bg-[#0B101D]/90 border-slate-800/80 backdrop-blur-md">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-600/30">
              <Printer className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className="font-bold tracking-tight text-base flex items-center gap-1.5">
                PrintFlow <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded">POS Hub</span>
              </span>
              <div className="flex items-center gap-3 text-xs text-slate-400 mt-0.5">
                <span className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
                  {isConnected ? 'WhatsApp Sync Active' : 'Disconnected'}
                </span>
                <span className="text-slate-600">•</span>
                <span className="flex items-center gap-1">
                  <Cpu className="w-3 h-3 text-slate-500" />
                  <span className={isBridgeOnline ? 'text-emerald-400 font-mono text-[11px]' : 'text-slate-500 font-mono text-[11px]'}>
                    {isBridgeOnline ? 'Local Bridge Active' : 'Bridge Offline'}
                  </span>
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Omnibar Search */}
        <div className="relative w-80">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search phone or token... (Press /)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-10 py-1.5 rounded-lg text-xs font-mono bg-slate-900 border border-slate-800 focus:border-indigo-500 text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono text-slate-400 border border-slate-700/60 rounded px-1.5 py-0.5 bg-slate-800/40">
            /
          </kbd>
        </div>

        {/* Global Controls & Pricing Settings */}
        <div className="flex items-center gap-4 text-xs font-medium">
          <div className="flex items-center gap-2">
            <span className="text-slate-400">Target Printer:</span>
            <select
              value={selectedPrinter}
              onChange={(e) => setSelectedPrinter(e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
            >
              {availablePrinters.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800">
            <span className="text-xs text-slate-300 font-medium">Auto-Print:</span>
            <button
              onClick={handleToggleAutoPrint}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                autoPrint ? 'bg-emerald-500' : 'bg-slate-700'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                  autoPrint ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
            <span className={`text-[10px] font-mono font-bold ${autoPrint ? 'text-emerald-400' : 'text-slate-500'}`}>
              {autoPrint ? 'ON' : 'OFF'}
            </span>
          </div>

          {/* Pricing Settings Button */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 transition"
            title="Set Price (Single / Double Sided)"
          >
            <Settings className="w-4 h-4 text-indigo-400" />
            <span className="font-semibold">Price Settings</span>
          </button>
        </div>
      </header>

      {/* Main Viewport */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Customer Queue Sidebar */}
        <aside className="w-80 border-r flex flex-col shrink-0 bg-[#090D18] border-slate-800/80">
          <div className="p-2 border-b border-slate-800/60 grid grid-cols-2 gap-1 bg-slate-950/60">
            <button
              onClick={() => setActiveTab('ACTIVE')}
              className={`py-1.5 text-xs font-semibold rounded-lg transition flex items-center justify-center gap-1.5 ${
                activeTab === 'ACTIVE'
                  ? 'bg-slate-800 text-indigo-400 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>Queue</span>
              <span className="px-1.5 py-0.2 rounded-full bg-slate-900 text-[10px] font-mono border border-slate-700">
                {activeSessionsList.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('COMPLETED')}
              className={`py-1.5 text-xs font-semibold rounded-lg transition flex items-center justify-center gap-1.5 ${
                activeTab === 'COMPLETED'
                  ? 'bg-slate-800 text-emerald-400 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>Done</span>
              <span className="px-1.5 py-0.2 rounded-full bg-slate-900 text-[10px] font-mono border border-slate-700">
                {completedSessionsList.length}
              </span>
            </button>
          </div>

          {activeTab === 'COMPLETED' && completedSessionsList.length > 0 && (
            <div className="px-3 py-2 border-b border-slate-800/60 flex items-center justify-between bg-slate-900/60">
              <span className="text-[11px] font-mono text-slate-400 flex items-center gap-1">
                <Clock className="w-3 h-3 text-slate-500" />
                Auto-purge 15m
              </span>
              <button
                onClick={handleClearAllCompleted}
                className="text-[11px] text-rose-400 hover:text-rose-300 font-semibold transition flex items-center gap-1 bg-rose-950/40 border border-rose-900/60 px-2 py-0.5 rounded"
              >
                <Trash2 className="w-3 h-3" />
                Clear All
              </button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {displayedList.length === 0 ? (
              <div className="p-8 text-center text-slate-500 space-y-2">
                <Sparkles className="w-8 h-8 mx-auto text-slate-600 animate-pulse" />
                <p className="text-xs font-medium">
                  {activeTab === 'ACTIVE' ? 'Active queue is empty.' : 'No completed orders.'}
                </p>
                <p className="text-[11px]">
                  {activeTab === 'ACTIVE' ? 'Customer WhatsApp files appear here.' : 'Cleared orders stay here for 15 minutes.'}
                </p>
              </div>
            ) : (
              displayedList.map((s) => {
                const isSelected = activeSession?.session_id === s.session_id;
                return (
                  <div
                    key={s.session_id}
                    onClick={() => setSelectedSessionId(s.session_id)}
                    className={`p-3.5 rounded-xl cursor-pointer transition-all border ${
                      isSelected
                        ? 'bg-slate-800/90 border-indigo-500/80 shadow-md shadow-indigo-950/40'
                        : 'bg-slate-900/40 border-slate-800/70 hover:bg-slate-850 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-xs font-bold text-slate-200">
                        {s.customer_phone}
                      </span>
                      <span className="text-[10px] font-mono text-slate-400 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {Math.max(1, Math.floor((Date.now() / 1000 - s.last_activity_at) / 60))}m ago
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>{s.documents.length} File{s.documents.length !== 1 ? 's' : ''} • {s.total_sheets} Sheets</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold ${
                        s.status === 'READY'
                          ? 'bg-emerald-950/70 text-emerald-400 border border-emerald-800/60'
                          : s.status === 'SPOOLING'
                          ? 'bg-amber-950/70 text-amber-400 border border-amber-800/60 animate-pulse'
                          : s.status === 'COMPLETED'
                          ? 'bg-slate-800 text-slate-400 border border-slate-700'
                          : 'bg-slate-800 text-slate-400'
                      }`}>
                        {s.status}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Staging Canvas */}
        <main className="flex-1 flex flex-col overflow-hidden relative">
          {activeSession ? (
            <>
              {/* Header Bar */}
              <div className="p-4 border-b flex items-center justify-between shrink-0 bg-[#0C1222]/70 border-slate-800/80">
                <div>
                  <div className="flex items-center gap-3">
                    <h2 className="text-base font-bold font-mono tracking-tight text-indigo-400">
                      {activeSession.customer_phone}
                    </h2>
                    {activeSession.status === 'COMPLETED' && (
                      <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-800 text-emerald-400 font-semibold font-mono">
                        <CheckCheck className="w-3 h-3" /> Handed Over
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {activeSession.documents.length} file(s) staged • Review options or print below
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleGlobalModeOverride('SIMPLEX')}
                    className="text-xs px-3.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition"
                  >
                    All Single-Sided
                  </button>
                  <button
                    onClick={() => handleGlobalModeOverride('DUPLEX')}
                    className="text-xs px-3.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition"
                  >
                    All Double-Sided
                  </button>

                  {activeSession.status !== 'COMPLETED' && (
                    <button
                      onClick={() => handleCompleteSession(activeSession.session_id)}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-emerald-800/80 bg-emerald-950/60 hover:bg-emerald-900/80 text-emerald-300 text-xs font-semibold transition ml-2"
                      title="Clear from active queue (Press Esc)"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Done & Handover (Esc)</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Document List */}
              <div className="flex-1 overflow-y-auto p-6 space-y-3 pb-28">
                {activeSession.documents.map((doc) => {
                  const isImage = doc.original_filename.match(/\.(jpg|jpeg|png|webp)$/i);
                  const isOddDouble = doc.print_mode === 'DUPLEX' && doc.page_count % 2 !== 0;

                  return (
                    <div
                      key={doc.id}
                      className="p-4 rounded-xl border flex items-center justify-between bg-[#0E1528] border-slate-800/80 hover:border-slate-700"
                    >
                      <div className="flex items-center gap-4">
                        <div className={`p-2.5 rounded-xl border ${
                          isImage
                            ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                            : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                        }`}>
                          {isImage ? <ImageIcon className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-slate-200 max-w-md truncate">
                              {doc.original_filename}
                            </span>
                            {isOddDouble && (
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-amber-950/60 text-amber-300 border border-amber-800/70">
                                +1 Blank Pad
                              </span>
                            )}
                            {doc.is_encrypted && (
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-rose-950/60 text-rose-300 border border-rose-800/70 flex items-center gap-1">
                                <Lock className="w-3 h-3" /> Password Protected
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-slate-400 font-mono mt-0.5 block">
                            {doc.page_count} Page{doc.page_count !== 1 ? 's' : ''} • A4 Size
                          </span>
                        </div>
                      </div>

                      <div className="bg-slate-950 p-1 rounded-xl border border-slate-800 flex items-center">
                        <button
                          onClick={() => handleModeChange(doc.id, 'SIMPLEX')}
                          className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition ${
                            doc.print_mode === 'SIMPLEX'
                              ? 'bg-indigo-600 text-white shadow'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Single-Sided
                        </button>
                        <button
                          onClick={() => handleModeChange(doc.id, 'DUPLEX')}
                          className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition ${
                            doc.print_mode === 'DUPLEX'
                              ? 'bg-indigo-600 text-white shadow'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Double-Sided
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Bottom Action Deck with Paper Consumed and Bill Due */}
              <div className="absolute bottom-0 left-0 right-0 p-4 border-t flex items-center justify-between z-20 bg-[#0B101D]/90 border-slate-800/80 backdrop-blur-xl">
                <div className="flex items-center gap-6">
                  <div>
                    <span className="text-[11px] uppercase font-mono text-slate-400 block tracking-wider">
                      Paper Consumed
                    </span>
                    <span className="text-base font-bold text-slate-100 flex items-center gap-1.5">
                      <Layers className="w-4 h-4 text-indigo-400" />
                      {sheetSummary.totalSheets} Sheets
                      <span className="text-xs font-normal text-slate-400">
                        ({sheetSummary.doubleSheets} Double + {sheetSummary.singleCount} Single)
                      </span>
                    </span>
                  </div>

                  <div className="h-8 w-px bg-slate-800" />

                  {/* Customer Bill Calculation */}
                  <div>
                    <span className="text-[11px] uppercase font-mono text-slate-400 block tracking-wider">
                      Total Due (Cash/UPI)
                    </span>
                    <span className="text-lg font-mono font-bold text-emerald-400 flex items-center gap-1">
                      ₹{sheetSummary.estimatedCost.toFixed(2)}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleDownloadMaster}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
                  >
                    <Download className="w-4 h-4" />
                    <span>Download Master PDF</span>
                  </button>

                  <button
                    onClick={handlePrintDirect}
                    disabled={isSpooling || activeSession.status === 'SPOOLING'}
                    className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-900 disabled:cursor-not-allowed text-white text-xs font-bold shadow-lg shadow-emerald-950/60 border border-emerald-400/30 transition-all active:scale-95"
                  >
                    {isSpooling ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Spooling via Hardware Bridge...</span>
                      </>
                    ) : (
                      <>
                        <Printer className="w-4 h-4" />
                        <span>Print Now</span>
                      </>
                    )}
                  </button>

                  {activeSession.status !== 'COMPLETED' && (
                    <button
                      onClick={() => handleCompleteSession(activeSession.session_id)}
                      className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-700 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-semibold transition"
                      title="Handover order and clear card (Esc)"
                    >
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      <span>Handover</span>
                    </button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-500 space-y-3">
              <Sparkles className="w-10 h-10 text-slate-600 animate-pulse" />
              <p className="text-sm font-medium">No Customer Selected</p>
              <p className="text-xs">Select a customer from the queue to view their documents.</p>
            </div>
          )}
        </main>
      </div>

      {/* Clean 2-Field Pricing Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm bg-[#0E1528] border border-slate-800 rounded-2xl p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-base flex items-center gap-2 text-slate-100">
                <Settings className="w-4 h-4 text-indigo-400" />
                Change Print Prices
              </h3>
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-400 mb-4">
              Set your per-sheet counter rates. Every customer bill updates automatically.
            </p>

            <div className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 font-medium mb-1">
                  Single-Sided Rate (₹ per sheet):
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={editSimplex}
                  onChange={(e) => setEditSimplex(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 font-mono text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">
                  Double-Sided Rate (₹ per physical sheet):
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={editDuplex}
                  onChange={(e) => setEditDuplex(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 font-mono text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="pt-3 flex items-center justify-end gap-2 border-t border-slate-800">
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="px-3.5 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSavePricing}
                  className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold shadow transition"
                >
                  Save Rates
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};