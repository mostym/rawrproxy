import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Box } from '@mui/material';
import Sidebar from './components/Layout/Sidebar';
import Header from './components/Layout/Header';
import Dashboard from './pages/Dashboard';
import Domains from './pages/Domains';
import Backends from './pages/Backends';
import Traffic from './pages/Traffic';
import Security from './pages/Security';
import Monitoring from './pages/Monitoring';
import Configuration from './pages/Configuration';
import Logs from './pages/Logs';
import { useWebSocket } from './hooks/useWebSocket';
import { useStore } from './store';

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { connect, disconnect } = useWebSocket();
  const setMetrics = useStore((state) => state.setMetrics);

  useEffect(() => {
    // Connect to WebSocket for real-time updates
    const wsUrl = window.location.protocol === 'https:' 
      ? `wss://${window.location.host}/ws`
      : `ws://${window.location.host}/ws`;
      
    connect(wsUrl, {
      onMessage: (data) => {
        if (data.type === 'metrics') {
          setMetrics(data.payload);
        }
      },
    });

    return () => {
      disconnect();
    };
  }, []);

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen(!sidebarOpen)} />
      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
        <Header onMenuClick={() => setSidebarOpen(!sidebarOpen)} />
        <Box component="main" sx={{ flexGrow: 1, p: 3 }}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/domains" element={<Domains />} />
            <Route path="/backends" element={<Backends />} />
            <Route path="/traffic" element={<Traffic />} />
            <Route path="/security" element={<Security />} />
            <Route path="/monitoring" element={<Monitoring />} />
            <Route path="/configuration" element={<Configuration />} />
            <Route path="/logs" element={<Logs />} />
          </Routes>
        </Box>
      </Box>
    </Box>
  );
}

export default App;