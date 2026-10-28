import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Printer,
  FileText,
  FileCheck2,
  Presentation,
  FileSpreadsheet,
  Image as ImageIcon,
  Lock,
  Clock,
  RefreshCw,
  Layers,
  Search,
  Sparkles,
  CheckCircle2,
  CheckCheck,
  Trash2,
  Settings,
  X,
  Eye,
  LogOut,
  Sun,
  Moon,
  ChevronDown,
  User,
  ShieldCheck,
  ExternalLink,
  Download,
  AlertTriangle
} from 'lucide-react';

interface DocumentMetadata {
  id: string;
  original_filename: string;
  normalized_path: string;
  source_path?: string;
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

interface OperatorDashboardProps {
  shopId?: string;
  onLogout?: () => void;
}

export const OperatorDashboard: React.FC<OperatorDashboardProps> = ({ shopId = 'default', onLogout }) => {
  const API_BASE = useMemo(() => {
    return (import.meta as any).env?.VITE_API_URL || `http://${window.location.hostname}:8000`;
  }, []);

  const WS_BASE = useMemo(() => {
    return API_BASE.replace(/^http/, 'ws');
  }, [API_BASE]);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('printflow_theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return 'light';
  });

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    localStorage.setItem('printflow_theme', next);
  };

  const isDark = theme === 'dark';

  const [sessions, setSessions] = useState<Record<string, SessionState>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'ACTIVE' | 'COMPLETED'>('ACTIVE');

  // Single global batch-level duplex toggle
  const [batchPrintMode, setBatchPrintMode] = useState<'SIMPLEX' | 'DUPLEX'>('SIMPLEX');

  // Pricing State
  const [pricing, setPricing] = useState<PricingConfig>({ rate_simplex: 2.0, rate_duplex: 3.0 });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [editSimplex, setEditSimplex] = useState('2.00');
  const [editDuplex, setEditDuplex] = useState('3.00');

  // In-App Lightbox State
  const [lightboxDoc, setLightboxDoc] = useState<{ id: string; filename: string; blobUrl: string } | null>(null);

  const [isConnected, setIsConnected] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setIsProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/api/v1/settings/pricing?shop_id=${shopId}`)
      .then((res) => res.json())
      .then((data) => {
        setPricing(data);
        setEditSimplex(data.rate_simplex.toFixed(2));
        setEditDuplex(data.rate_duplex.toFixed(2));
      })
      .catch(() => {});
  }, [API_BASE, shopId]);

  useEffect(() => {
    const wsUrl = `${WS_BASE}/ws/operator?shop_id=${shopId}`;
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
        } else if (msg.event === `SESSION_UPDATED:${shopId}`) {
          const updated: SessionState = msg.payload;
          setSessions((prev) => ({ ...prev, [updated.session_id]: updated }));
          setSelectedSessionId((curr) => curr || updated.session_id);
        } else if (msg.event === `SESSION_PURGED:${shopId}`) {
          const purgedId = msg.payload.session_id;
          setSessions((prev) => {
            const next = { ...prev };
            delete next[purgedId];
            return next;
          });
          setSelectedSessionId((curr) => (curr === purgedId ? null : curr));
        } else if (msg.event === `PRICING_UPDATED:${shopId}`) {
          setPricing(msg.payload);
          setEditSimplex(msg.payload.rate_simplex.toFixed(2));
          setEditDuplex(msg.payload.rate_duplex.toFixed(2));
        } else if (msg.event === `GATEWAY_STATUS_UPDATED:${shopId}`) {
          if (msg.payload.status === 'LOGGED_OUT' || msg.payload.status === 'SCAN_REQUIRED') {
            if (onLogout) onLogout();
          }
        }
      } catch (err) {
        console.error('Socket decoding error:', err);
      }
    };

    return () => ws.close();
  }, [WS_BASE, selectedSessionId, shopId, onLogout]);

  const executeLogoutWhatsApp = async () => {
    setShowLogoutConfirm(false);
    setIsProfileOpen(false);

    try {
      await fetch(`${API_BASE}/api/v1/gateway/logout?shop_id=${shopId}`, {
        method: 'POST'
      });
    } catch (err) {
      console.warn('[LOGOUT] Network notice:', err);
    } finally {
      setSessions({});
      setSelectedSessionId(null);
      if (onLogout) onLogout();
    }
  };

  const handleSavePricing = async () => {
    const payload: PricingConfig = {
      rate_simplex: parseFloat(editSimplex) || 2.0,
      rate_duplex: parseFloat(editDuplex) || 3.0
    };
    try {
      await fetch(`${API_BASE}/api/v1/settings/pricing?shop_id=${shopId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      setIsSettingsOpen(false);
    } catch (err) {
      alert(`Failed to save pricing: ${err}`);
    }
  };

  const handleCompleteSession = async (sessionId: string) => {
    try {
      await fetch(`${API_BASE}/api/v1/sessions/${sessionId}/complete?shop_id=${shopId}`, {
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
      await fetch(`${API_BASE}/api/v1/sessions/clear-completed?shop_id=${shopId}`, {
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

  // Direct Raw/Source Document Download Action
  const handleDownloadSourceDoc = (docId: string) => {
    if (!activeSession) return;
    const url = `${API_BASE}/api/v1/sessions/${activeSession.session_id}/documents/${docId}/source?shop_id=${shopId}`;
    const link = document.createElement('a');
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handlePreviewAndPrintMaster = async () => {
    if (!activeSession) return;
    setIsPreviewLoading(true);
    try {
      const url = `${API_BASE}/api/v1/sessions/${activeSession.session_id}/download?shop_id=${shopId}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to compile master document.');

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const previewWindow = window.open(blobUrl, '_blank');
      if (!previewWindow) {
        alert('Popup blocked. Please allow popups for this site to preview documents.');
      } else {
        previewWindow.onload = () => {
          previewWindow.focus();
          previewWindow.print();
        };
      }

      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (err) {
      alert(`Preview error: ${err}`);
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const handleDirectDownloadMaster = async () => {
    if (!activeSession) return;
    try {
      const url = `${API_BASE}/api/v1/sessions/${activeSession.session_id}/download?shop_id=${shopId}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch master PDF.');
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `PrintFlow_${activeSession.customer_phone.replace(/[^0-9]/g, '') || 'docs'}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      alert(`Download failed: ${err}`);
    }
  };

  // Strict Modal Precedence Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showLogoutConfirm) {
          e.preventDefault();
          e.stopPropagation();
          setShowLogoutConfirm(false);
          return;
        }
        if (isSettingsOpen) {
          e.preventDefault();
          e.stopPropagation();
          setIsSettingsOpen(false);
          return;
        }
        if (isProfileOpen) {
          e.preventDefault();
          e.stopPropagation();
          setIsProfileOpen(false);
          return;
        }
        if (lightboxDoc) {
          e.preventDefault();
          e.stopPropagation();
          closeLightbox();
          return;
        }
        if (activeSession) {
          e.preventDefault();
          handleCompleteSession(activeSession.session_id);
        }
      }

      if (e.key === '/' && document.activeElement !== searchInputRef.current) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }

      if (e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        handleDirectDownloadMaster();
      }

      if (e.key === 'Enter' && activeSession && !lightboxDoc && !isSettingsOpen && !isProfileOpen && !showLogoutConfirm) {
        const tagName = (document.activeElement?.tagName || '').toLowerCase();
        if (tagName !== 'input' && tagName !== 'textarea') {
          e.preventDefault();
          handlePreviewAndPrintMaster();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const openLightbox = async (doc: DocumentMetadata) => {
    if (!activeSession) return;
    try {
      const url = `${API_BASE}/api/v1/sessions/${activeSession.session_id}/documents/${doc.id}/preview?shop_id=${shopId}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Unable to load document preview.');

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      setLightboxDoc({ id: doc.id, filename: doc.original_filename, blobUrl });
    } catch (err) {
      alert(`Lightbox error: ${err}`);
    }
  };

  const closeLightbox = () => {
    if (lightboxDoc?.blobUrl) {
      URL.revokeObjectURL(lightboxDoc.blobUrl);
    }
    setLightboxDoc(null);
  };

  // Pure Batch-Level Sheet and Billing Calculation
  const sheetSummary = useMemo(() => {
    if (!activeSession) return { totalPages: 0, physicalSheets: 0, estimatedCost: 0 };
    
    let totalPages = 0;
    activeSession.documents.forEach((d) => {
      if (!d.is_corrupted) {
        totalPages += d.page_count;
      }
    });

    if (batchPrintMode === 'SIMPLEX') {
      const physicalSheets = totalPages;
      const estimatedCost = physicalSheets * pricing.rate_simplex;
      return { totalPages, physicalSheets, estimatedCost };
    } else {
      const physicalSheets = Math.ceil(totalPages / 2);
      const estimatedCost = physicalSheets * pricing.rate_duplex;
      return { totalPages, physicalSheets, estimatedCost };
    }
  }, [activeSession, batchPrintMode, pricing]);

  // Distinct Icon Badge Renderer for Supported Document Types
  const renderDocumentBadge = (filename: string, pageCount: number) => {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const hasCount = pageCount > 0;
    const countLabel = hasCount ? `${pageCount}P` : '...';

    // 1. PowerPoint & Presentation Slides
    if (['ppt', 'pptx', 'odp', 'pps', 'ppsx'].includes(ext)) {
      return (
        <div className={`relative group w-12 h-16 rounded-xl border flex flex-col items-center justify-center shrink-0 transition active:scale-95 shadow-xs ${
          isDark 
            ? 'bg-amber-950/40 border-amber-800/60 text-amber-400' 
            : 'bg-amber-50 border-amber-200 text-amber-600'
        }`}>
          <Presentation className="w-5 h-5 group-hover:scale-110 transition" />
          <span className="text-[9px] font-mono font-bold mt-1 tracking-tight">{countLabel}</span>
          <span className="text-[8px] font-mono font-black uppercase opacity-75">PPT</span>
          <div className="absolute inset-0 bg-amber-600/80 text-white rounded-xl flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <Eye className="w-4 h-4" />
          </div>
        </div>
      );
    }

    // 2. Excel & Spreadsheets
    if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) {
      return (
        <div className={`relative group w-12 h-16 rounded-xl border flex flex-col items-center justify-center shrink-0 transition active:scale-95 shadow-xs ${
          isDark 
            ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-400' 
            : 'bg-emerald-50 border-emerald-200 text-emerald-600'
        }`}>
          <FileSpreadsheet className="w-5 h-5 group-hover:scale-110 transition" />
          <span className="text-[9px] font-mono font-bold mt-1 tracking-tight">{countLabel}</span>
          <span className="text-[8px] font-mono font-black uppercase opacity-75">XLS</span>
          <div className="absolute inset-0 bg-emerald-600/80 text-white rounded-xl flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <Eye className="w-4 h-4" />
          </div>
        </div>
      );
    }

    // 3. Word & Text Documents
    if (['doc', 'docx', 'odt', 'rtf', 'txt'].includes(ext)) {
      return (
        <div className={`relative group w-12 h-16 rounded-xl border flex flex-col items-center justify-center shrink-0 transition active:scale-95 shadow-xs ${
          isDark 
            ? 'bg-blue-950/40 border-blue-800/60 text-blue-400' 
            : 'bg-blue-50 border-blue-200 text-blue-600'
        }`}>
          <FileCheck2 className="w-5 h-5 group-hover:scale-110 transition" />
          <span className="text-[9px] font-mono font-bold mt-1 tracking-tight">{countLabel}</span>
          <span className="text-[8px] font-mono font-black uppercase opacity-75">DOC</span>
          <div className="absolute inset-0 bg-blue-600/80 text-white rounded-xl flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <Eye className="w-4 h-4" />
          </div>
        </div>
      );
    }

    // 4. Camera Scans & Images
    if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff'].includes(ext)) {
      return (
        <div className={`relative group w-12 h-16 rounded-xl border flex flex-col items-center justify-center shrink-0 transition active:scale-95 shadow-xs ${
          isDark 
            ? 'bg-teal-950/40 border-teal-800/60 text-teal-400' 
            : 'bg-teal-50 border-teal-200 text-teal-600'
        }`}>
          <ImageIcon className="w-5 h-5 group-hover:scale-110 transition" />
          <span className="text-[9px] font-mono font-bold mt-1 tracking-tight">{countLabel}</span>
          <span className="text-[8px] font-mono font-black uppercase opacity-75">IMG</span>
          <div className="absolute inset-0 bg-teal-600/80 text-white rounded-xl flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <Eye className="w-4 h-4" />
          </div>
        </div>
      );
    }

    // 5. Standard PDF
    if (ext === 'pdf') {
      return (
        <div className={`relative group w-12 h-16 rounded-xl border flex flex-col items-center justify-center shrink-0 transition active:scale-95 shadow-xs ${
          isDark 
            ? 'bg-rose-950/40 border-rose-800/60 text-rose-400' 
            : 'bg-rose-50 border-rose-200 text-rose-600'
        }`}>
          <FileText className="w-5 h-5 group-hover:scale-110 transition" />
          <span className="text-[9px] font-mono font-bold mt-1 tracking-tight">{countLabel}</span>
          <span className="text-[8px] font-mono font-black uppercase opacity-75">PDF</span>
          <div className="absolute inset-0 bg-rose-600/80 text-white rounded-xl flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <Eye className="w-4 h-4" />
          </div>
        </div>
      );
    }

    // 6. Generic Fallback
    return (
      <div className={`relative group w-12 h-16 rounded-xl border flex flex-col items-center justify-center shrink-0 transition active:scale-95 shadow-xs ${
        isDark 
          ? 'bg-indigo-950/40 border-indigo-800/60 text-indigo-400' 
          : 'bg-indigo-50 border-indigo-200 text-indigo-600'
      }`}>
        <FileText className="w-5 h-5 group-hover:scale-110 transition" />
        <span className="text-[9px] font-mono font-bold mt-1 tracking-tight">{countLabel}</span>
        <span className="text-[8px] font-mono font-black uppercase opacity-75">FILE</span>
        <div className="absolute inset-0 bg-indigo-600/80 text-white rounded-xl flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <Eye className="w-4 h-4" />
        </div>
      </div>
    );
  };

  return (
    <div className={`h-screen w-screen flex flex-col overflow-hidden select-none font-sans transition-colors duration-200 ${
      isDark ? 'bg-[#070A11] text-slate-100' : 'bg-[#F8FAFC] text-slate-900'
    }`}>
      
      {/* Top Navbar */}
      <header className={`relative z-50 h-16 px-6 border-b flex items-center justify-between shrink-0 transition-colors duration-200 ${
        isDark 
          ? 'bg-[#0B101D]/90 border-slate-800/80 backdrop-blur-md' 
          : 'bg-white/90 border-slate-200/90 shadow-sm backdrop-blur-md'
      }`}>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-blue-600 flex items-center justify-center shadow-md shadow-indigo-600/25">
              <Printer className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className={`font-bold tracking-tight text-base flex items-center gap-2 ${
                isDark ? 'text-slate-100' : 'text-slate-900'
              }`}>
                PrintFlow 
                <span className={`text-[11px] font-mono font-semibold px-2 py-0.5 rounded-md border ${
                  isDark 
                    ? 'bg-indigo-950/60 text-indigo-300 border-indigo-800/60' 
                    : 'bg-indigo-50 text-indigo-700 border-indigo-200'
                }`}>
                  {shopId}
                </span>
              </span>
              <div className="flex items-center gap-2 text-xs mt-0.5">
                <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
                <span className={isDark ? 'text-slate-300' : 'text-slate-600 font-medium'}>
                  {isConnected ? 'WhatsApp Sync Active' : 'Disconnected'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Omnibar Search */}
        <div className="relative w-96">
          <Search className={`w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 ${
            isDark ? 'text-slate-400' : 'text-slate-500'
          }`} />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search phone or token... (Press /)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={`w-full pl-10 pr-10 py-2 rounded-xl text-xs font-mono transition outline-none ${
              isDark 
                ? 'bg-slate-900 border border-slate-800 text-slate-100 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 placeholder-slate-500' 
                : 'bg-slate-100 border border-slate-200 text-slate-900 focus:border-indigo-600 focus:bg-white focus:ring-1 focus:ring-indigo-600 placeholder-slate-400'
            }`}
          />
          <kbd className={`absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono rounded px-1.5 py-0.5 border ${
            isDark 
              ? 'text-slate-400 border-slate-700 bg-slate-800/50' 
              : 'text-slate-500 border-slate-300 bg-slate-200/60'
          }`}>
            /
          </kbd>
        </div>

        {/* Header Right */}
        <div className="flex items-center gap-3 text-xs font-medium">
          <button
            onClick={toggleTheme}
            className={`p-2 rounded-xl border transition flex items-center justify-center ${
              isDark 
                ? 'border-slate-800 bg-slate-900 text-amber-400 hover:bg-slate-800' 
                : 'border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
            title={`Switch to ${isDark ? 'Light' : 'Dark'} mode`}
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <div className="relative" ref={profileMenuRef}>
            <button
              onClick={() => setIsProfileOpen(!isProfileOpen)}
              className={`flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-xl border transition ${
                isDark 
                  ? 'border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-200' 
                  : 'border-slate-200 bg-white hover:bg-slate-100 text-slate-800 shadow-sm'
              }`}
            >
              <div className="w-7 h-7 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold text-xs uppercase">
                {shopId.charAt(shopId.length - 1)}
              </div>
              <span className="font-mono text-xs font-semibold">{shopId}</span>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>

            {isProfileOpen && (
              <div className={`absolute right-0 mt-2 w-64 rounded-2xl border p-2 shadow-2xl z-[100] animate-in fade-in slide-in-from-top-2 duration-150 ${
                isDark 
                  ? 'bg-[#0E1528] border-slate-800 text-slate-200 shadow-black/80' 
                  : 'bg-white border-slate-200 text-slate-800 shadow-slate-300/60'
              }`}>
                <div className={`p-3 rounded-xl mb-1.5 border ${
                  isDark ? 'bg-slate-900/80 border-slate-800/80' : 'bg-slate-50 border-slate-100'
                }`}>
                  <div className="flex items-center gap-2 mb-1">
                    <User className="w-4 h-4 text-indigo-500" />
                    <span className="text-xs font-bold">Counter Terminal</span>
                  </div>
                  <p className="text-[11px] font-mono text-slate-500 truncate">ID: {shopId}</p>
                  <div className="flex items-center gap-1.5 text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold mt-1.5">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>Isolated Workspace Active</span>
                  </div>
                </div>

                <div className="space-y-1">
                  <button
                    onClick={() => {
                      setIsProfileOpen(false);
                      setIsSettingsOpen(true);
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition ${
                      isDark ? 'hover:bg-slate-800/80 text-slate-200' : 'hover:bg-slate-100 text-slate-700'
                    }`}
                  >
                    <Settings className="w-3.5 h-3.5 text-indigo-500" />
                    <span>Counter Rate Card</span>
                  </button>

                  <div className={`h-px my-1 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`} />

                  <button
                    onClick={() => {
                      setIsProfileOpen(false);
                      setShowLogoutConfirm(true);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Disconnect Counter (Logout)</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Viewport */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Customer Queue Sidebar */}
        <aside className={`w-80 border-r flex flex-col shrink-0 transition-colors duration-200 ${
          isDark ? 'bg-[#090D18] border-slate-800/80' : 'bg-white border-slate-200'
        }`}>
          <div className={`p-2 border-b grid grid-cols-2 gap-1 ${
            isDark ? 'border-slate-800/60 bg-slate-950/60' : 'border-slate-200 bg-slate-50'
          }`}>
            <button
              onClick={() => setActiveTab('ACTIVE')}
              className={`py-1.5 text-xs font-bold rounded-lg transition flex items-center justify-center gap-1.5 ${
                activeTab === 'ACTIVE'
                  ? (isDark ? 'bg-slate-800 text-indigo-400 shadow-sm' : 'bg-white text-indigo-600 shadow-sm border border-slate-200')
                  : (isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800')
              }`}
            >
              <span>Queue</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono border ${
                isDark ? 'bg-slate-900 text-slate-300 border-slate-700' : 'bg-slate-100 text-slate-700 border-slate-300'
              }`}>
                {activeSessionsList.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('COMPLETED')}
              className={`py-1.5 text-xs font-bold rounded-lg transition flex items-center justify-center gap-1.5 ${
                activeTab === 'COMPLETED'
                  ? (isDark ? 'bg-slate-800 text-emerald-400 shadow-sm' : 'bg-white text-emerald-600 shadow-sm border border-slate-200')
                  : (isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800')
              }`}
            >
              <span>Done</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono border ${
                isDark ? 'bg-slate-900 text-slate-300 border-slate-700' : 'bg-slate-100 text-slate-700 border-slate-300'
              }`}>
                {completedSessionsList.length}
              </span>
            </button>
          </div>

          {activeTab === 'COMPLETED' && completedSessionsList.length > 0 && (
            <div className={`px-3 py-2 border-b flex items-center justify-between ${
              isDark ? 'border-slate-800/60 bg-slate-900/60' : 'border-slate-200 bg-slate-100'
            }`}>
              <span className={`text-[11px] font-mono flex items-center gap-1 ${
                isDark ? 'text-slate-300' : 'text-slate-600 font-medium'
              }`}>
                <Clock className="w-3 h-3 text-slate-400" />
                Auto-purge 15m
              </span>
              <button
                onClick={handleClearAllCompleted}
                className="text-[11px] text-rose-600 dark:text-rose-400 hover:underline font-semibold transition flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" />
                Clear All
              </button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {displayedList.length === 0 ? (
              <div className="p-8 text-center space-y-2">
                <Sparkles className="w-8 h-8 mx-auto text-slate-400 dark:text-slate-600 animate-pulse" />
                <p className={`text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                  {activeTab === 'ACTIVE' ? 'Active queue is empty.' : 'No completed orders.'}
                </p>
                <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
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
                        ? isDark
                          ? 'bg-slate-800/90 border-indigo-500 shadow-md shadow-indigo-950/40 text-slate-100'
                          : 'bg-indigo-50/70 border-indigo-400 shadow-sm text-slate-900'
                        : isDark
                          ? 'bg-slate-900/40 border-slate-800/70 hover:bg-slate-800/60'
                          : 'bg-white border-slate-200/80 hover:bg-slate-50 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className={`font-mono text-xs font-bold ${
                        isSelected ? (isDark ? 'text-indigo-300' : 'text-indigo-900') : (isDark ? 'text-slate-100' : 'text-slate-900')
                      }`}>
                        {s.customer_phone}
                      </span>
                      <span className={`text-[10px] font-mono flex items-center gap-1 ${
                        isDark ? 'text-slate-300' : 'text-slate-500 font-medium'
                      }`}>
                        <Clock className="w-3 h-3" />
                        {Math.max(1, Math.floor((Date.now() / 1000 - s.last_activity_at) / 60))}m ago
                      </span>
                    </div>

                    <div className={`flex items-center justify-between text-[11px] ${
                      isDark ? 'text-slate-300' : 'text-slate-600 font-medium'
                    }`}>
                      <span>{s.documents.length} File{s.documents.length !== 1 ? 's' : ''} • {s.total_sheets} Sheets</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                        s.status === 'READY'
                          ? isDark
                            ? 'bg-emerald-950/70 text-emerald-400 border border-emerald-800/60'
                            : 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          : s.status === 'SPOOLING'
                          ? isDark
                            ? 'bg-amber-950/70 text-amber-400 border border-amber-800/60 animate-pulse'
                            : 'bg-amber-100 text-amber-800 border border-amber-300 animate-pulse'
                          : s.status === 'COMPLETED'
                          ? isDark
                            ? 'bg-slate-800 text-slate-300 border border-slate-700'
                            : 'bg-slate-200 text-slate-700 border border-slate-300'
                          : 'bg-slate-800 text-slate-300'
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
              {/* Header Bar with Batch-Level Duplex Toggle */}
              <div className={`p-4 border-b flex items-center justify-between shrink-0 transition-colors ${
                isDark ? 'bg-[#0C1222]/70 border-slate-800/80' : 'bg-white border-slate-200'
              }`}>
                <div>
                  <div className="flex items-center gap-3">
                    <h2 className="text-base font-bold font-mono tracking-tight text-indigo-600 dark:text-indigo-400">
                      {activeSession.customer_phone}
                    </h2>
                    {activeSession.status === 'COMPLETED' && (
                      <span className={`flex items-center gap-1 text-[11px] px-2.5 py-0.5 rounded-md font-semibold font-mono border ${
                        isDark 
                          ? 'bg-emerald-950/50 text-emerald-400 border-emerald-800/60' 
                          : 'bg-emerald-50 text-emerald-800 border-emerald-200 shadow-xs'
                      }`}>
                        <CheckCheck className="w-3.5 h-3.5" /> Handed Over
                      </span>
                    )}
                  </div>
                  <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-300' : 'text-slate-500 font-medium'}`}>
                    {activeSession.documents.length} file(s) staged • Press <strong>Enter</strong> to Print All, <strong>Alt+D</strong> to Download
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  {/* Clean Batch-Level Duplex Switcher */}
                  <div className={`p-1 rounded-xl border flex items-center gap-1 ${
                    isDark ? 'bg-slate-900 border-slate-800' : 'bg-slate-100 border-slate-300'
                  }`}>
                    <button
                      onClick={() => setBatchPrintMode('SIMPLEX')}
                      className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg transition ${
                        batchPrintMode === 'SIMPLEX'
                          ? 'bg-blue-600 text-white shadow-md'
                          : isDark
                            ? 'text-slate-300 hover:text-white hover:bg-slate-800'
                            : 'text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 shadow-xs'
                      }`}
                    >
                      <span>📄</span>
                      <span>Single-Sided Batch</span>
                    </button>
                    <button
                      onClick={() => setBatchPrintMode('DUPLEX')}
                      className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg transition ${
                        batchPrintMode === 'DUPLEX'
                          ? 'bg-blue-600 text-white shadow-md'
                          : isDark
                            ? 'text-slate-300 hover:text-white hover:bg-slate-800'
                            : 'text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 shadow-xs'
                      }`}
                    >
                      <span>📑</span>
                      <span>Double-Sided Batch</span>
                    </button>
                  </div>

                  {/* Dedicated Handover Action */}
                  {activeSession.status !== 'COMPLETED' && (
                    <button
                      onClick={() => handleCompleteSession(activeSession.session_id)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-emerald-600 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-sm ml-1"
                      title="Clear from active queue (Press Esc)"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Done & Handover (Esc)</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Clean Document List (Zero Row-Level Toggles, Direct Source Downloads) */}
              <div className="flex-1 overflow-y-auto p-6 space-y-3 pb-32">
                {activeSession.documents.map((doc) => {
                  const hasPageCount = doc.page_count > 0;

                  return (
                    <div
                      key={doc.id}
                      className={`p-4 rounded-xl border flex items-center justify-between transition-colors ${
                        isDark 
                          ? 'bg-[#0E1528] border-slate-800/90 hover:border-slate-700' 
                          : 'bg-white border-slate-200 hover:border-slate-300 shadow-sm'
                      }`}
                    >
                      <div className="flex items-center gap-4">
                        <div 
                          onClick={() => openLightbox(doc)} 
                          className="cursor-pointer"
                          title="Click to view full preview"
                        >
                          {renderDocumentBadge(doc.original_filename, doc.page_count)}
                        </div>

                        <div>
                          <div className="flex items-center gap-2">
                            <span 
                              onClick={() => openLightbox(doc)}
                              className={`text-sm font-bold max-w-md truncate cursor-pointer transition ${
                                isDark ? 'text-slate-100 hover:text-indigo-400' : 'text-slate-900 hover:text-indigo-600'
                              }`}
                            >
                              {doc.original_filename}
                            </span>
                            {doc.is_encrypted && (
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded-md font-bold bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-300 dark:border-rose-800/70 flex items-center gap-1">
                                <Lock className="w-3 h-3" /> Protected
                              </span>
                            )}
                          </div>
                          <span className={`text-xs font-mono font-semibold mt-0.5 block ${
                            isDark ? 'text-slate-300' : 'text-slate-600'
                          }`}>
                            {hasPageCount ? `${doc.page_count} Page${doc.page_count !== 1 ? 's' : ''}` : 'Counting pages...'} • A4 Standard
                          </span>
                        </div>
                      </div>

                      {/* Right Row Actions: Direct Source Download & Inspect */}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleDownloadSourceDoc(doc.id)}
                          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition ${
                            isDark
                              ? 'border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200'
                              : 'border-slate-300 bg-white hover:bg-slate-100 text-slate-700 shadow-xs'
                          }`}
                          title="Download original file for editing in Word/Excel/Photoshop"
                        >
                          <Download className="w-3.5 h-3.5 text-indigo-500" />
                          <span>Original File</span>
                        </button>

                        <button
                          onClick={() => openLightbox(doc)}
                          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition ${
                            isDark
                              ? 'border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200'
                              : 'border-slate-300 bg-white hover:bg-slate-100 text-slate-700 shadow-xs'
                          }`}
                          title="Inspect document"
                        >
                          <Eye className="w-3.5 h-3.5 text-slate-400" />
                          <span>Inspect</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Bottom Production Dock */}
              <div className={`absolute bottom-0 left-0 right-0 p-5 border-t flex items-center justify-between z-20 transition-colors backdrop-blur-xl ${
                isDark ? 'bg-[#0B101D]/95 border-slate-800/90' : 'bg-white/95 border-slate-200 shadow-2xl'
              }`}>
                <div className="flex items-center gap-8">
                  <div>
                    <span className={`text-[11px] uppercase font-mono font-bold block tracking-wider ${
                      isDark ? 'text-slate-400' : 'text-slate-500'
                    }`}>
                      Paper Consumed
                    </span>
                    <span className={`text-lg font-extrabold flex items-center gap-2 ${
                      isDark ? 'text-slate-100' : 'text-slate-900'
                    }`}>
                      <Layers className="w-5 h-5 text-indigo-500" />
                      {sheetSummary.physicalSheets} Physical Sheets
                      <span className={`text-xs font-normal ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        ({sheetSummary.totalPages} Total Pages • {batchPrintMode === 'SIMPLEX' ? '1-Sided' : 'Back-to-Back'})
                      </span>
                    </span>
                  </div>

                  <div className={`h-10 w-px ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`} />

                  <div>
                    <span className={`text-[11px] uppercase font-mono font-bold block tracking-wider ${
                      isDark ? 'text-slate-400' : 'text-slate-500'
                    }`}>
                      TOTAL DUE (CASH / UPI)
                    </span>
                    <span className="text-3xl font-mono font-black text-emerald-600 dark:text-emerald-400 flex items-center gap-1 tracking-tight">
                      ₹{sheetSummary.estimatedCost.toFixed(2)}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleDirectDownloadMaster}
                    className={`flex items-center gap-1.5 px-3.5 py-3 rounded-xl border text-xs font-bold transition ${
                      isDark 
                        ? 'border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200' 
                        : 'border-slate-300 bg-white hover:bg-slate-100 text-slate-700 shadow-sm'
                    }`}
                    title="Download Master PDF (Alt + D)"
                  >
                    <Download className="w-4 h-4" />
                    <span>Master PDF (Alt+D)</span>
                  </button>

                  <button
                    onClick={handlePreviewAndPrintMaster}
                    disabled={isPreviewLoading}
                    className="flex items-center gap-2.5 px-7 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-900 disabled:cursor-not-allowed text-white text-sm font-black shadow-xl shadow-emerald-600/30 transition-all active:scale-95"
                    title="Open compiled document with instant print dialog (Press Enter)"
                  >
                    {isPreviewLoading ? (
                      <>
                        <RefreshCw className="w-5 h-5 animate-spin" />
                        <span>Compiling Master PDF...</span>
                      </>
                    ) : (
                      <>
                        <Printer className="w-5 h-5" />
                        <span>PRINT ALL ({sheetSummary.physicalSheets} Sheets)</span>
                        <kbd className="hidden md:inline-block ml-1 text-[10px] font-mono bg-emerald-700/80 px-2 py-0.5 rounded border border-emerald-400/30 font-semibold">
                          ↵ Enter
                        </kbd>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center space-y-3">
              <Sparkles className="w-10 h-10 text-slate-400 dark:text-slate-600 animate-pulse" />
              <p className={`text-sm font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>No Customer Selected</p>
              <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500 font-medium'}`}>Select a customer from the queue to view their documents.</p>
            </div>
          )}
        </main>
      </div>

      {/* Logout Confirmation Modal */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className={`w-full max-w-sm rounded-3xl p-6 shadow-2xl border ${
            isDark ? 'bg-[#0E1528] border-slate-800 text-slate-100' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className="w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-500 flex items-center justify-center mb-4">
              <AlertTriangle className="w-6 h-6" />
            </div>

            <h3 className="text-base font-bold mb-1">Disconnect Counter WhatsApp?</h3>
            <p className={`text-xs leading-relaxed mb-6 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              This will unlink the active phone from workspace <strong className="font-mono">{shopId}</strong> and generate a fresh pairing QR code.
            </p>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowLogoutConfirm(false)}
                className={`px-4 py-2 rounded-xl text-xs font-semibold border transition ${
                  isDark ? 'border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-750' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                }`}
              >
                Cancel (Esc)
              </button>
              <button
                onClick={executeLogoutWhatsApp}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition shadow-lg shadow-rose-600/25 active:scale-95"
              >
                Disconnect Counter
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-App Lightbox Modal Preview */}
      {lightboxDoc && (
        <div 
          onClick={closeLightbox}
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-4xl h-[85vh] rounded-2xl flex flex-col overflow-hidden shadow-2xl border ${
              isDark ? 'bg-[#0E1528] border-slate-800' : 'bg-white border-slate-200'
            }`}
          >
            <div className={`h-14 px-6 border-b flex items-center justify-between shrink-0 ${
              isDark ? 'border-slate-800 bg-[#0B101D]' : 'border-slate-200 bg-slate-50'
            }`}>
              <div className="flex items-center gap-2 max-w-lg truncate">
                <FileText className="w-4 h-4 text-indigo-500 shrink-0" />
                <span className={`text-sm font-bold truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                  {lightboxDoc.filename}
                </span>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => window.open(lightboxDoc.blobUrl, '_blank')}
                  className={`p-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition ${
                    isDark ? 'border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                  }`}
                  title="Open in new window"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Popout</span>
                </button>
                <button
                  onClick={closeLightbox}
                  className={`p-1.5 rounded-lg border transition ${
                    isDark ? 'border-slate-700 hover:bg-slate-800 text-slate-400' : 'border-slate-300 hover:bg-slate-200 text-slate-600'
                  }`}
                  title="Close (Esc)"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 bg-slate-950 flex items-center justify-center overflow-hidden p-2">
              <iframe
                src={lightboxDoc.blobUrl}
                title="Document Preview"
                className="w-full h-full rounded-lg border-0 bg-white"
              />
            </div>
          </div>
        </div>
      )}

      {/* Pricing Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className={`w-full max-w-sm rounded-3xl p-6 shadow-2xl border ${
            isDark ? 'bg-[#0E1528] border-slate-800 text-slate-100' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-base flex items-center gap-2">
                <Settings className="w-4 h-4 text-indigo-500" />
                Change Print Prices
              </h3>
              <button
                onClick={() => setIsSettingsOpen(false)}
                className={isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className={`text-xs mb-4 ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>
              Set your per-sheet counter rates. Every customer bill updates automatically.
            </p>

            <div className="space-y-4 text-xs">
              <div>
                <label className={`block font-semibold mb-1 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  Single-Sided Rate (₹ per sheet):
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={editSimplex}
                  onChange={(e) => setEditSimplex(e.target.value)}
                  className={`w-full rounded-xl px-3 py-2.5 font-mono text-sm border focus:outline-none focus:ring-2 focus:ring-blue-600 transition ${
                    isDark 
                      ? 'bg-slate-900 border-slate-700 text-slate-100' 
                      : 'bg-slate-50 border-slate-300 text-slate-900 focus:bg-white shadow-xs'
                  }`}
                />
              </div>

              <div>
                <label className={`block font-semibold mb-1 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  Double-Sided Rate (₹ per physical sheet):
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={editDuplex}
                  onChange={(e) => setEditDuplex(e.target.value)}
                  className={`w-full rounded-xl px-3 py-2.5 font-mono text-sm border focus:outline-none focus:ring-2 focus:ring-blue-600 transition ${
                    isDark 
                      ? 'bg-slate-900 border-slate-700 text-slate-100' 
                      : 'bg-slate-50 border-slate-300 text-slate-900 focus:bg-white shadow-xs'
                  }`}
                />
              </div>

              <div className={`pt-4 flex items-center justify-end gap-2 border-t ${
                isDark ? 'border-slate-800' : 'border-slate-200'
              }`}>
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className={`px-3.5 py-2 rounded-xl border font-semibold transition ${
                    isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  Cancel (Esc)
                </button>
                <button
                  onClick={handleSavePricing}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold shadow-md transition active:scale-95"
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