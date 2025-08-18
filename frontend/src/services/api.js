import axios from 'axios';
import toast from 'react-hot-toast';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8081/api';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor
apiClient.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const message = error.response?.data?.message || error.message || 'An error occurred';
    
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    } else {
      toast.error(message);
    }
    
    return Promise.reject(error);
  }
);

export const api = {
  // Dashboard
  getDashboard: () => apiClient.get('/dashboard'),
  getMetrics: () => apiClient.get('/metrics'),
  
  // Domains
  getDomains: () => apiClient.get('/domains'),
  createDomain: (data) => apiClient.post('/domains', data),
  updateDomain: (id, data) => apiClient.put(`/domains/${id}`, data),
  deleteDomain: (id) => apiClient.delete(`/domains/${id}`),
  
  // Backends
  getBackends: () => apiClient.get('/backends'),
  createBackend: (data) => apiClient.post('/backends', data),
  updateBackend: (id, data) => apiClient.put(`/backends/${id}`, data),
  deleteBackend: (id) => apiClient.delete(`/backends/${id}`),
  checkBackendHealth: (id) => apiClient.get(`/backends/${id}/health`),
  
  // Traffic
  getTraffic: (params) => apiClient.get('/traffic', { params }),
  getTrafficStats: () => apiClient.get('/traffic/stats'),
  
  // Security
  getSecurityEvents: () => apiClient.get('/security/events'),
  getWAFRules: () => apiClient.get('/security/waf/rules'),
  updateWAFRule: (id, data) => apiClient.put(`/security/waf/rules/${id}`, data),
  getIPWhitelist: () => apiClient.get('/security/ip/whitelist'),
  addToWhitelist: (ip) => apiClient.post('/security/ip/whitelist', { ip }),
  getIPBlacklist: () => apiClient.get('/security/ip/blacklist'),
  addToBlacklist: (ip) => apiClient.post('/security/ip/blacklist', { ip }),
  
  // Monitoring
  getMonitoringData: () => apiClient.get('/monitoring'),
  getAlerts: () => apiClient.get('/monitoring/alerts'),
  acknowledgeAlert: (id) => apiClient.post(`/monitoring/alerts/${id}/acknowledge`),
  
  // Configuration
  getConfiguration: () => apiClient.get('/configuration'),
  updateConfiguration: (data) => apiClient.put('/configuration', data),
  exportConfiguration: () => apiClient.get('/configuration/export'),
  importConfiguration: (data) => apiClient.post('/configuration/import', data),
  
  // Logs
  getLogs: (params) => apiClient.get('/logs', { params }),
  getLogStats: () => apiClient.get('/logs/stats'),
  downloadLogs: (params) => apiClient.get('/logs/download', { params, responseType: 'blob' }),
  
  // Auth
  login: (credentials) => apiClient.post('/auth/login', credentials),
  register: (data) => apiClient.post('/auth/register', data),
  refreshToken: () => apiClient.post('/auth/refresh'),
  logout: () => apiClient.post('/auth/logout'),
};

export default apiClient;