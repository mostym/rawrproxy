import { create } from 'zustand';

export const useStore = create((set) => ({
  // Metrics state
  metrics: {
    requests: 0,
    activeConnections: 0,
    avgResponseTime: 0,
    errorRate: 0,
    cacheHitRate: 0,
    bandwidth: {
      in: 0,
      out: 0,
    },
  },
  setMetrics: (metrics) => set({ metrics }),

  // Real-time traffic
  realtimeTraffic: [],
  addTrafficEntry: (entry) =>
    set((state) => ({
      realtimeTraffic: [...state.realtimeTraffic.slice(-99), entry],
    })),

  // Domains
  domains: [],
  setDomains: (domains) => set({ domains }),

  // Backends
  backends: [],
  setBackends: (backends) => set({ backends }),

  // Alerts
  alerts: [],
  addAlert: (alert) =>
    set((state) => ({
      alerts: [alert, ...state.alerts].slice(0, 50),
    })),
  clearAlerts: () => set({ alerts: [] }),

  // User preferences
  preferences: {
    darkMode: true,
    autoRefresh: true,
    refreshInterval: 5000,
  },
  setPreferences: (preferences) =>
    set((state) => ({
      preferences: { ...state.preferences, ...preferences },
    })),
}));