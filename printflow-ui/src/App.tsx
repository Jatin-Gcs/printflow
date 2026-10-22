import React, { useState, useEffect } from 'react';
import { OperatorDashboard } from './components/OperatorDashboard';
import { PairingScreen } from './components/PairingScreen';
import { getOrCreateShopId } from './utils/shopSession';

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<'PAIRING' | 'DASHBOARD'>('PAIRING');
  const shopId = getOrCreateShopId();

  const checkStatus = async () => {
    try {
      const apiBase = (import.meta as any).env?.VITE_API_URL || `http://${window.location.hostname}:8000`;
      const res = await fetch(`${apiBase}/api/v1/gateway/status?shop_id=${shopId}`);
      const data = await res.json();
      if (data.status === 'CONNECTED') {
        setCurrentView('DASHBOARD');
      } else {
        setCurrentView('PAIRING');
      }
    } catch {
      setCurrentView('PAIRING');
    }
  };

  useEffect(() => {
    checkStatus();
  }, [shopId]);

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