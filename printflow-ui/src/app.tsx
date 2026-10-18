import React, { useState, useEffect } from 'react';
import { OperatorDashboard } from './components/OperatorDashboard';
import { PairingScreen } from './components/PairingScreen';

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<'PAIRING' | 'DASHBOARD'>('DASHBOARD');

  useEffect(() => {
    // Check initial gateway status
    fetch(`http://${window.location.hostname}:8000/api/v1/gateway/status`)
      .then((res) => res.json())
      .then((data) => {
        if (data.status === 'SCAN_REQUIRED' || data.status === 'LOGGED_OUT') {
          setCurrentView('PAIRING');
        } else {
          setCurrentView('DASHBOARD');
        }
      })
      .catch(() => setCurrentView('DASHBOARD'));
  }, []);

  if (currentView === 'PAIRING') {
    return <PairingScreen onPaired={() => setCurrentView('DASHBOARD')} />;
  }

  return <OperatorDashboard />;
};

export default App;