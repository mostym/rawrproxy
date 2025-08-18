import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Box,
  Typography,
  Divider,
  IconButton,
  Chip,
} from '@mui/material';
import {
  Dashboard as DashboardIcon,
  Language as DomainIcon,
  Storage as BackendIcon,
  Timeline as TrafficIcon,
  Security as SecurityIcon,
  MonitorHeart as MonitoringIcon,
  Settings as ConfigIcon,
  Description as LogsIcon,
  ChevronLeft as ChevronLeftIcon,
  RocketLaunch as RocketIcon,
} from '@mui/icons-material';

const menuItems = [
  { path: '/dashboard', label: 'Dashboard', icon: <DashboardIcon /> },
  { path: '/domains', label: 'Domains', icon: <DomainIcon /> },
  { path: '/backends', label: 'Backends', icon: <BackendIcon /> },
  { path: '/traffic', label: 'Traffic', icon: <TrafficIcon />, badge: 'live' },
  { path: '/security', label: 'Security', icon: <SecurityIcon /> },
  { path: '/monitoring', label: 'Monitoring', icon: <MonitoringIcon /> },
  { path: '/configuration', label: 'Configuration', icon: <ConfigIcon /> },
  { path: '/logs', label: 'Logs', icon: <LogsIcon /> },
];

const drawerWidth = 280;

function Sidebar({ open, onToggle }) {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <Drawer
      sx={{
        width: open ? drawerWidth : 72,
        flexShrink: 0,
        '& .MuiDrawer-paper': {
          width: open ? drawerWidth : 72,
          boxSizing: 'border-box',
          background: 'linear-gradient(180deg, #1e293b 0%, #0f172a 100%)',
          borderRight: '1px solid rgba(255, 255, 255, 0.05)',
          transition: 'width 0.3s ease',
          overflowX: 'hidden',
        },
      }}
      variant="permanent"
      anchor="left"
    >
      <Box sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {open && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <RocketIcon sx={{ color: 'primary.main', fontSize: 32 }} />
            <Box>
              <Typography variant="h6" sx={{ fontWeight: 700, color: 'white' }}>
                RAWRProxy
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                v2.0.0
              </Typography>
            </Box>
          </Box>
        )}
        <IconButton onClick={onToggle} size="small" sx={{ color: 'text.secondary' }}>
          <ChevronLeftIcon sx={{ transform: open ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.3s' }} />
        </IconButton>
      </Box>

      <Divider sx={{ borderColor: 'rgba(255, 255, 255, 0.05)' }} />

      <List sx={{ px: 1, py: 2 }}>
        {menuItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <ListItem key={item.path} disablePadding sx={{ mb: 0.5 }}>
              <ListItemButton
                onClick={() => navigate(item.path)}
                sx={{
                  borderRadius: 2,
                  backgroundColor: isActive ? 'rgba(139, 92, 246, 0.1)' : 'transparent',
                  borderLeft: isActive ? '3px solid #8b5cf6' : '3px solid transparent',
                  '&:hover': {
                    backgroundColor: isActive ? 'rgba(139, 92, 246, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                  },
                }}
              >
                <ListItemIcon
                  sx={{
                    color: isActive ? 'primary.main' : 'text.secondary',
                    minWidth: open ? 56 : 40,
                  }}
                >
                  {item.icon}
                </ListItemIcon>
                {open && (
                  <>
                    <ListItemText
                      primary={item.label}
                      sx={{
                        '& .MuiListItemText-primary': {
                          color: isActive ? 'white' : 'text.secondary',
                          fontWeight: isActive ? 600 : 400,
                        },
                      }}
                    />
                    {item.badge && (
                      <Chip
                        label={item.badge}
                        size="small"
                        color="success"
                        sx={{ height: 20, fontSize: '0.7rem' }}
                      />
                    )}
                  </>
                )}
              </ListItemButton>
            </ListItem>
          );
        })}
      </List>

      <Box sx={{ flexGrow: 1 }} />

      {open && (
        <Box sx={{ p: 2 }}>
          <Box
            sx={{
              p: 2,
              borderRadius: 2,
              background: 'rgba(139, 92, 246, 0.1)',
              border: '1px solid rgba(139, 92, 246, 0.2)',
            }}
          >
            <Typography variant="caption" sx={{ color: 'primary.main', fontWeight: 600 }}>
              SYSTEM STATUS
            </Typography>
            <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: '#10b981',
                  animation: 'pulse 2s infinite',
                }}
              />
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                All systems operational
              </Typography>
            </Box>
          </Box>
        </Box>
      )}

      <style jsx>{`
        @keyframes pulse {
          0% {
            box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
          }
          70% {
            box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
          }
        }
      `}</style>
    </Drawer>
  );
}

export default Sidebar;