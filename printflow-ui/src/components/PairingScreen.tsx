import React, { useState, useEffect, useMemo } from 'react';
import { 
  CheckCircle2, 
  RefreshCw, 
  ShieldCheck, 
  ArrowRight,
  Printer
} from 'lucide-react';

interface PairingScreenProps {
  onPaired: () => void;
}

export const PairingScreen: React.FC<PairingScreenProps> = ({ onPaired }) => {
  const API_BASE = useMemo(() => {
    return (import.meta as any).env?.VITE_API_URL || `http://${window.location.hostname}:8000`;
  }, []);

  const WS_BASE = useMemo(() => {
    return API_BASE.replace(/^http/, 'ws');
  }, [API_BASE]);

  const [gatewayStatus, setGatewayStatus] = useState<string>('CONNECTING');
  const [qrImage, setQrImage] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/v1/gateway/status`)
      .then((res) => res.json())
      .then((data) => {
        setGatewayStatus(data.status);
        setQrImage(data.qr_image);
        if (data.status === 'CONNECTED') {
          onPaired();
        }
      })
      .catch(() => setGatewayStatus('DISCONNECTED'));

    const wsUrl = `${WS_BASE}/ws/operator`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.event === 'GATEWAY_STATUS_UPDATED') {
          setGatewayStatus(msg.payload.status);
          setQrImage(msg.payload.qr_image);
          if (msg.payload.status === 'CONNECTED') {
            onPaired();
          }
        }
      } catch (err) {
        console.error('Socket message parse error:', err);
      }
    };

    return () => ws.close();
  }, [API_BASE, WS_BASE, onPaired]);

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#070A11] text-slate-100 select-none p-6 font-sans">
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-600/30">
          <Printer className="w-5 h-5 text-white" />
        </div>
        <h1 className="text-xl font-bold tracking-tight">
          PrintFlow <span className="text-indigo-400 font-mono text-xs px-2 py-0.5 rounded bg-indigo-950/60 border border-indigo-800 ml-2">Setup Station</span>
        </h1>
      </div>

      <div className="max-w-md w-full bg-[#0D1322] border border-slate-800/80 rounded-2xl p-8 shadow-2xl flex flex-col items-center">
        {gatewayStatus === 'CONNECTED' ? (
          <div className="py-8 flex flex-col items-center space-y-4 text-center">
            <div className="w-16 h-16 rounded-full bg-emerald-950/80 border border-emerald-800/80 flex items-center justify-center text-emerald-400">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h2 className="text-lg font-bold text-slate-100">WhatsApp Linked Successfully</h2>
            <p className="text-xs text-slate-400 max-w-xs">
              Your counter is paired. Incoming customer files will automatically appear on the POS dashboard.
            </p>
            <button
              onClick={onPaired}
              className="mt-4 flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 transition"
            >
              <span>Go to POS Dashboard</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <>
            <div className="text-center mb-6">
              <h2 className="text-lg font-bold text-slate-100">Link Shop WhatsApp</h2>
              <p className="text-xs text-slate-400 mt-1">
                Scan the QR code below using the shop's counter smartphone.
              </p>
            </div>

            <div className="relative w-64 h-64 bg-white rounded-2xl p-3 shadow-inner flex items-center justify-center border-4 border-slate-800/40">
              {qrImage ? (
                <img
                  src={qrImage}
                  alt="WhatsApp Pairing QR"
                  className="w-full h-full object-contain rounded-lg"
                />
              ) : (
                <div className="flex flex-col items-center justify-center space-y-3 text-slate-400">
                  <RefreshCw className="w-8 h-8 animate-spin text-indigo-500" />
                  <span className="text-[11px] font-mono">Generating secure key...</span>
                </div>
              )}
            </div>

            <div className="w-full mt-6 space-y-2.5 text-xs text-slate-300 bg-slate-900/60 border border-slate-800/80 rounded-xl p-4">
              <div className="flex items-center gap-3">
                <span className="w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 font-mono text-[11px] font-bold flex items-center justify-center border border-indigo-500/30 shrink-0">1</span>
                <span>Open <strong>WhatsApp</strong> on your shop phone</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 font-mono text-[11px] font-bold flex items-center justify-center border border-indigo-500/30 shrink-0">2</span>
                <span>Tap <strong>Menu (⋮)</strong> or <strong>Settings</strong> → <strong>Linked Devices</strong></span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 font-mono text-[11px] font-bold flex items-center justify-center border border-indigo-500/30 shrink-0">3</span>
                <span>Tap <strong>Link a Device</strong> and point your camera here</span>
              </div>
            </div>

            <div className="mt-6 flex items-center gap-2 text-[11px] text-slate-400 font-mono">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Multi-device local end-to-end encrypted link</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
};