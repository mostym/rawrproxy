import React, { useEffect, useState } from 'react';
import {
  Grid,
  Paper,
  Typography,
  Box,
  Card,
  CardContent,
  LinearProgress,
  Chip,
  IconButton,
} from '@mui/material';
import {
  TrendingUp as TrendingUpIcon,
  TrendingDown as TrendingDownIcon,
  Speed as SpeedIcon,
  Storage as StorageIcon,
  Security as SecurityIcon,
  CloudQueue as CloudIcon,
  Refresh as RefreshIcon,
  ArrowUpward as ArrowUpIcon,
  ArrowDownward as ArrowDownIcon,
} from '@mui/icons-material';
import { LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { api } from '../services/api';
import { useStore } from '../store';

const COLORS = ['#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899'];

function MetricCard({ title, value, unit, icon, trend, color = 'primary.main' }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <Card sx={{ height: '100%', background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.1) 0%, rgba(16, 185, 129, 0.1) 100%)' }}>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <Box>
              <Typography variant="caption" color="text.secondary" gutterBottom>
                {title}
              </Typography>
              <Typography variant="h4" sx={{ fontWeight: 700, color }}>
                {value}
                <Typography component="span" variant="body1" sx={{ ml: 0.5, color: 'text.secondary' }}>
                  {unit}
                </Typography>
              </Typography>
              {trend && (
                <Box sx={{ display: 'flex', alignItems: 'center', mt: 1 }}>
                  {trend.direction === 'up' ? (
                    <TrendingUpIcon sx={{ fontSize: 16, color: 'success.main', mr: 0.5 }} />
                  ) : (
                    <TrendingDownIcon sx={{ fontSize: 16, color: 'error.main', mr: 0.5 }} />
                  )}
                  <Typography variant="caption" color={trend.direction === 'up' ? 'success.main' : 'error.main'}>
                    {trend.value}% from last hour
                  </Typography>
                </Box>
              )}
            </Box>
            <Box sx={{ color, opacity: 0.3 }}>{icon}</Box>
          </Box>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function Dashboard() {
  const metrics = useStore((state) => state.metrics);
  const [trafficData, setTrafficData] = useState([]);
  const [statusData, setStatusData] = useState([]);
  const [backendHealth, setBackendHealth] = useState([]);

  // Fetch dashboard data
  const { data: dashboardData, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.getDashboard(),
    refetchInterval: 5000,
  });

  // Generate mock real-time data for charts
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      const time = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
      
      setTrafficData(prev => [...prev.slice(-19), {
        time,
        requests: Math.floor(Math.random() * 1000) + 500,
        errors: Math.floor(Math.random() * 50),
        latency: Math.floor(Math.random() * 100) + 20,
      }]);

      setStatusData([
        { name: '2xx', value: Math.floor(Math.random() * 5000) + 15000, color: '#10b981' },
        { name: '3xx', value: Math.floor(Math.random() * 1000) + 2000, color: '#3b82f6' },
        { name: '4xx', value: Math.floor(Math.random() * 500) + 500, color: '#f59e0b' },
        { name: '5xx', value: Math.floor(Math.random() * 100) + 50, color: '#ef4444' },
      ]);

      setBackendHealth([
        { name: 'backend-1', healthy: 95, unhealthy: 5 },
        { name: 'backend-2', healthy: 88, unhealthy: 12 },
        { name: 'backend-3', healthy: 100, unhealthy: 0 },
        { name: 'backend-4', healthy: 72, unhealthy: 28 },
      ]);
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  return (
    <Box>
      <Box sx={{ mb: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Dashboard
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Real-time system overview and metrics
          </Typography>
        </Box>
        <IconButton onClick={refetch} sx={{ color: 'primary.main' }}>
          <RefreshIcon />
        </IconButton>
      </Box>

      {/* Metric Cards */}
      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <MetricCard
            title="Total Requests"
            value="1.2M"
            unit="today"
            icon={<CloudIcon sx={{ fontSize: 40 }} />}
            trend={{ direction: 'up', value: 12.5 }}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <MetricCard
            title="Avg Response Time"
            value={metrics.avgResponseTime.toFixed(0)}
            unit="ms"
            icon={<SpeedIcon sx={{ fontSize: 40 }} />}
            trend={{ direction: 'down', value: 8.3 }}
            color="success.main"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <MetricCard
            title="Active Connections"
            value={metrics.activeConnections}
            unit="live"
            icon={<StorageIcon sx={{ fontSize: 40 }} />}
            trend={{ direction: 'up', value: 5.2 }}
            color="info.main"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <MetricCard
            title="Security Events"
            value="3"
            unit="blocked"
            icon={<SecurityIcon sx={{ fontSize: 40 }} />}
            color="warning.main"
          />
        </Grid>
      </Grid>

      {/* Charts */}
      <Grid container spacing={3}>
        {/* Traffic Chart */}
        <Grid item xs={12} md={8}>
          <Paper sx={{ p: 3, height: 400 }}>
            <Typography variant="h6" gutterBottom>
              Traffic Overview
            </Typography>
            <ResponsiveContainer width="100%" height="90%">
              <AreaChart data={trafficData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                <XAxis dataKey="time" stroke="#94a3b8" />
                <YAxis stroke="#94a3b8" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                  }}
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="requests"
                  stroke="#8b5cf6"
                  fill="rgba(139, 92, 246, 0.3)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="errors"
                  stroke="#ef4444"
                  fill="rgba(239, 68, 68, 0.3)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </Paper>
        </Grid>

        {/* Status Codes Pie Chart */}
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 3, height: 400 }}>
            <Typography variant="h6" gutterBottom>
              Response Status
            </Typography>
            <ResponsiveContainer width="100%" height="90%">
              <PieChart>
                <Pie
                  data={statusData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={(entry) => `${entry.name}: ${entry.value}`}
                  outerRadius={100}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {statusData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </Paper>
        </Grid>

        {/* Backend Health */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3, height: 350 }}>
            <Typography variant="h6" gutterBottom>
              Backend Health
            </Typography>
            <ResponsiveContainer width="100%" height="90%">
              <BarChart data={backendHealth}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                <XAxis dataKey="name" stroke="#94a3b8" />
                <YAxis stroke="#94a3b8" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                  }}
                />
                <Legend />
                <Bar dataKey="healthy" stackId="a" fill="#10b981" />
                <Bar dataKey="unhealthy" stackId="a" fill="#ef4444" />
              </BarChart>
            </ResponsiveContainer>
          </Paper>
        </Grid>

        {/* Bandwidth Usage */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3, height: 350 }}>
            <Typography variant="h6" gutterBottom>
              Bandwidth Usage
            </Typography>
            <Box sx={{ mt: 3 }}>
              <Box sx={{ mb: 3 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                  <Typography variant="body2" color="text.secondary">
                    Inbound
                  </Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center' }}>
                    <ArrowDownIcon sx={{ fontSize: 16, color: 'info.main', mr: 0.5 }} />
                    <Typography variant="body2">
                      {(metrics.bandwidth.in / 1024 / 1024).toFixed(2)} MB/s
                    </Typography>
                  </Box>
                </Box>
                <LinearProgress
                  variant="determinate"
                  value={Math.min((metrics.bandwidth.in / 10485760) * 100, 100)}
                  sx={{
                    height: 8,
                    borderRadius: 4,
                    '& .MuiLinearProgress-bar': {
                      background: 'linear-gradient(90deg, #3b82f6 0%, #8b5cf6 100%)',
                    },
                  }}
                />
              </Box>
              <Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                  <Typography variant="body2" color="text.secondary">
                    Outbound
                  </Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center' }}>
                    <ArrowUpIcon sx={{ fontSize: 16, color: 'success.main', mr: 0.5 }} />
                    <Typography variant="body2">
                      {(metrics.bandwidth.out / 1024 / 1024).toFixed(2)} MB/s
                    </Typography>
                  </Box>
                </Box>
                <LinearProgress
                  variant="determinate"
                  value={Math.min((metrics.bandwidth.out / 10485760) * 100, 100)}
                  sx={{
                    height: 8,
                    borderRadius: 4,
                    '& .MuiLinearProgress-bar': {
                      background: 'linear-gradient(90deg, #10b981 0%, #8b5cf6 100%)',
                    },
                  }}
                />
              </Box>
            </Box>

            <Box sx={{ mt: 4 }}>
              <Typography variant="subtitle2" gutterBottom>
                Cache Performance
              </Typography>
              <Box sx={{ display: 'flex', gap: 2, mt: 2 }}>
                <Chip
                  label={`Hit Rate: ${(metrics.cacheHitRate * 100).toFixed(1)}%`}
                  color="success"
                  size="small"
                />
                <Chip
                  label={`Size: 256 MB`}
                  color="primary"
                  size="small"
                />
                <Chip
                  label={`Entries: 1,234`}
                  variant="outlined"
                  size="small"
                />
              </Box>
            </Box>
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
}

export default Dashboard;