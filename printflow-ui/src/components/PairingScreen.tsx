import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  CheckCircle2, 
  RefreshCw, 
  ShieldCheck, 
  ArrowRight, 
  Printer, 
  Smartphone, 
  Settings, 
  QrCode 
} from 'lucide-react';

interface PairingScreenProps {
  shopId: string;
  onPaired: () => void;
}

export const PairingScreen: React.FC<PairingScreenProps> = ({ shopId, onPaired }) => {
  // Resilient API base URL: Checks env var -> checks if localhost -> falls back to live EC2 backend
  const API_BASE = useMemo(() => {
    const envUrl = (import.meta as any).env?.VITE_API_URL;
    if (envUrl && envUrl.trim().length > 0) return envUrl;
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return 'http://127.0.0.1:8000';
    }
    return 'https://printflow-hub.duckdns.org';
  }, []);

  const WS_BASE = useMemo(() => API_BASE.replace(/^http/, 'ws'), [API_BASE]);
  const [gatewayStatus, setGatewayStatus] = useState<string>('CONNECTING');
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(20);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const currentQrRef = useRef<string | null>(null);
  const pollIntervalRef = useRef<any>(null);

  const applyNewQr = (newQr: string) => {
    if (newQr && newQr !== currentQrRef.current) {
      currentQrRef.current = newQr;
      setQrImage(newQr);
      setTimeLeft(20);
    }
  };

  const fetchStatus = async (isManual = false) => {
    if (isManual) setIsRefreshing(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/gateway/status?shop_id=${shopId}`);
      if (!res.ok) throw new Error('Status fetch failed');
      const data = await res.json();
      setGatewayStatus(data.status);

      if (data.status === 'CONNECTED' || data.status === 'AUTHENTICATED') {
        onPaired();
        return;
      }

      if (data.qr_image) {
        applyNewQr(data.qr_image);
      }
    } catch (err) {
      console.warn('[PAIRING] Fetch notice:', err);
    } finally {
      if (isManual) setIsRefreshing(false);
    }
  };

  const handleManualRefresh = () => {
    currentQrRef.current = null;
    fetchStatus(true);
  };

  useEffect(() => {
    fetchStatus();

    // Poll status every 4 seconds without resetting countdown
    pollIntervalRef.current = setInterval(() => {
      fetchStatus(false);
    }, 4000);

    const wsUrl = `${WS_BASE}/ws/operator?shop_id=${shopId}`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.event === 'INITIAL_SNAPSHOT') {
          const status = msg.gateway_state?.status;
          if (status) setGatewayStatus(status);
          if (status === 'CONNECTED' || status === 'AUTHENTICATED') onPaired();
          if (msg.gateway_state?.qr_image) {
            applyNewQr(msg.gateway_state.qr_image);
          }
        }

        if (msg.event === `GATEWAY_STATUS_UPDATED:${shopId}`) {
          const status = msg.payload?.status;
          if (status) setGatewayStatus(status);
          if (status === 'CONNECTED' || status === 'AUTHENTICATED') onPaired();
          if (msg.payload?.qr_image) {
            applyNewQr(msg.payload.qr_image);
          }
        }
      } catch (err) {
        console.error('Socket message parse error:', err);
      }
    };

    return () => {
      ws.close();
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [API_BASE, WS_BASE, shopId, onPaired]);

  // Smooth 1-second countdown interval
  useEffect(() => {
    if (gatewayStatus === 'CONNECTED' || !qrImage) return;

    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [gatewayStatus, qrImage]);

  const isExpired = timeLeft === 0;
  const progressPercent = (timeLeft / 20) * 100;

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#070A11] text-slate-100 select-none p-6 font-sans relative overflow-hidden">
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-indigo-600/10 blur-[130px] rounded-full pointer-events-none" />

      {/* Brand Header */}
      <div className="flex items-center gap-3 mb-8 relative z-10">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-600/30">
          <Printer className="w-5 h-5 text-white" />
        </div>
        <h1 className="text-xl font-bold tracking-tight">
          PrintFlow <span className="text-indigo-400 font-mono text-xs px-2 py-0.5 rounded bg-indigo-950/60 border border-indigo-800 ml-2">Setup Station</span>
        </h1>
      </div>

      {/* Main Container Card */}
      <div className="max-w-md w-full bg-[#0D1322] border border-slate-800/80 rounded-3xl p-8 shadow-2xl flex flex-col items-center relative z-10 backdrop-blur-xl">
        {gatewayStatus === 'CONNECTED' || gatewayStatus === 'AUTHENTICATED' ? (
          <div className="py-8 flex flex-col items-center space-y-4 text-center animate-in fade-in zoom-in-95 duration-200">
            <div className="w-16 h-16 rounded-full bg-emerald-950/80 border border-emerald-800/80 flex items-center justify-center text-emerald-400">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h2 className="text-lg font-bold text-slate-100">WhatsApp Linked Successfully</h2>
            <p className="text-xs text-slate-400 max-w-xs">
              Device paired to workspace. Redirecting to counter dashboard...
            </p>
            <button
              onClick={onPaired}
              className="mt-4 flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 transition active:scale-95"
            >
              <span>Go to POS Dashboard</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <>
            <div className="text-center mb-6">
              <h2 className="text-lg font-bold text-slate-100">Link Counter WhatsApp</h2>
              <p className="text-xs text-slate-400 mt-1 font-mono">
                Workspace: <span className="text-indigo-400 font-bold px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800">{shopId}</span>
              </p>
            </div>

            {/* QR Container with 20s Countdown Ring */}
            <div className="relative p-3 bg-white rounded-2xl shadow-inner flex items-center justify-center border-4 border-slate-800/40">
              {qrImage ? (
                <div className="relative w-64 h-64 flex items-center justify-center">
                  <img
                    src={qrImage}
                    alt="WhatsApp Pairing QR"
                    className={`w-full h-full object-contain rounded-lg transition-all duration-300 ${
                      isExpired ? 'filter blur-sm opacity-20' : 'opacity-100'
                    }`}
                  />

                  {/* QR Expired Overlay */}
                  {isExpired && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center bg-black/60 rounded-lg backdrop-blur-xs">
                      <RefreshCw className="w-7 h-7 text-white mb-2 animate-spin" />
                      <p className="text-xs font-bold text-white mb-2">QR Expired</p>
                      <button
                        onClick={handleManualRefresh}
                        disabled={isRefreshing}
                        className="px-3.5 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold rounded-lg shadow-md transition active:scale-95"
                      >
                        Reload Fresh QR
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="w-64 h-64 flex flex-col items-center justify-center space-y-3 text-slate-700">
                  <RefreshCw className="w-8 h-8 animate-spin text-indigo-600" />
                  <span className="text-[11px] font-mono font-medium">Generating dedicated QR...</span>
                </div>
              )}

              {/* Circular 20-second Progress Ring */}
              {qrImage && !isExpired && (
                <div className="absolute -top-3 -right-3 w-9 h-9 bg-slate-900 border border-slate-700 rounded-full flex items-center justify-center shadow-lg">
                  <svg className="w-8 h-8 transform -rotate-90">
                    <circle cx="16" cy="16" r="13" stroke="#1e293b" strokeWidth="2.5" fill="none" />
                    <circle
                      cx="16"
                      cy="16"
                      r="13"
                      stroke="#10b981"
                      strokeWidth="2.5"
                      strokeDasharray={81.68}
                      strokeDashoffset={81.68 - (81.68 * progressPercent) / 100}
                      strokeLinecap="round"
                      fill="none"
                      className="transition-all duration-1000 ease-linear"
                    />
                  </svg>
                  <span className="absolute text-[10px] font-mono font-bold text-slate-200">
                    {timeLeft}
                  </span>
                </div>
              )}
            </div>

            {/* Step-by-Step Onboarding with Smartphone Cues */}
            <div className="w-full mt-6 space-y-2.5 text-xs text-slate-300 bg-slate-900/60 border border-slate-800/80 rounded-2xl p-4">
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center border border-indigo-500/20 shrink-0">
                  <Smartphone className="w-3.5 h-3.5" />
                </div>
                <span>Open <strong>WhatsApp</strong> on shop phone</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-lg bg-blue-500/10 text-blue-400 flex items-center justify-center border border-blue-500/20 shrink-0">
                  <Settings className="w-3.5 h-3.5" />
                </div>
                <span>Tap <strong>Linked Devices</strong> → <strong>Link a Device</strong></span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center border border-emerald-500/20 shrink-0">
                  <QrCode className="w-3.5 h-3.5" />
                </div>
                <span>Point camera at this screen to pair</span>
              </div>
            </div>

            <div className="mt-5 flex items-center gap-2 text-[11px] text-slate-400 font-mono">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Isolated shop credential store</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
};