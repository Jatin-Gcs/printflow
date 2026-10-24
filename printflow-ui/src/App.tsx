import React, { useState, useEffect } from 'react';
import { Monitor, ArrowRight } from 'lucide-react';
import { OperatorDashboard } from './components/OperatorDashboard';
import { PairingScreen } from './components/PairingScreen';
import { getOrCreateShopId } from './utils/shopSession';

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<'PAIRING' | 'DASHBOARD'>('PAIRING');
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const shopId = getOrCreateShopId();

  // Detect mobile device or small viewport width (< 768px)
  useEffect(() => {
    const evaluateDevice = () => {
      const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent
      );
      const isNarrowScreen = window.innerWidth < 768;
      setIsMobile(isMobileUA || isNarrowScreen);
    };

    evaluateDevice();
    window.addEventListener('resize', evaluateDevice);
    return () => window.removeEventListener('resize', evaluateDevice);
  }, []);

  const checkStatus = async () => {
    try {
      const apiBase =
        (import.meta as any).env?.VITE_API_URL ||
        (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
          ? 'http://127.0.0.1:8000'
          : 'https://printflow-hub.duckdns.org');

      const res = await fetch(`${apiBase}/api/v1/gateway/status?shop_id=${shopId}`);
      const data = await res.json();
      if (data.status === 'CONNECTED' || data.status === 'AUTHENTICATED') {
        setCurrentView('DASHBOARD');
      } else {
        setCurrentView('PAIRING');
      }
    } catch {
      setCurrentView('PAIRING');
    }
  };

  useEffect(() => {
    if (!isMobile) {
      checkStatus();
    }
  }, [shopId, isMobile]);

  // Mobile Device Notice View
  if (isMobile) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#070A11] text-slate-100 p-6 select-none font-sans text-center">
        <div className="max-w-sm w-full bg-[#0D1322] border border-slate-800 rounded-3xl p-8 shadow-2xl flex flex-col items-center animate-in fade-in zoom-in-95 duration-200">
          <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mb-5">
            <Monitor className="w-8 h-8" />
          </div>

          <span className="text-[10px] font-mono font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-amber-950/60 text-amber-300 border border-amber-800 mb-3">
            Desktop Terminal Only
          </span>

          <h2 className="text-xl font-bold tracking-tight text-white mb-2">
            Not Supported on Mobile
          </h2>

          <p className="text-xs text-slate-400 leading-relaxed mb-6">
            PrintFlow is a point-of-sale counter workstation built for PC and laptop displays connected to physical print hardware.
          </p>

          <div className="w-full bg-slate-900/80 border border-slate-800 rounded-2xl p-4 text-left space-y-2 text-xs text-slate-300 mb-6">
            <div className="flex items-center gap-2 text-indigo-400 font-semibold">
              <ArrowRight className="w-4 h-4 shrink-0" />
              <span>Open on your counter computer:</span>
            </div>
            <p className="text-[11px] font-mono text-slate-400 break-all pl-6">
              {window.location.origin}
            </p>
          </div>

          <p className="text-[11px] text-slate-500">
            Customers send documents via WhatsApp; they do not need to open this terminal.
          </p>
        </div>
      </div>
    );
  }

  // Counter Desktop Views
  if (currentView === 'PAIRING') {
    return (
      <PairingScreen
        shopId={shopId}
        onPaired={() => setCurrentView('DASHBOARD')}
      />
    );
  }

  return (
    <OperatorDashboard
      shopId={shopId}
      onLogout={() => setCurrentView('PAIRING')}
    />
  );
};

export default App;