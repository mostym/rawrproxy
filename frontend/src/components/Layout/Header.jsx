import React, { useState } from 'react';
import {
  AppBar,
  Toolbar,
  IconButton,
  Typography,
  Box,
  Badge,
  Avatar,
  Menu,
  MenuItem,
  Chip,
  TextField,
  InputAdornment,
} from '@mui/material';
import {
  Menu as MenuIcon,
  Notifications as NotificationsIcon,
  Search as SearchIcon,
  DarkMode as DarkModeIcon,
  LightMode as LightModeIcon,
  Person as PersonIcon,
  Settings as SettingsIcon,
  Logout as LogoutIcon,
  Speed as SpeedIcon,
} from '@mui/icons-material';
import { useStore } from '../../store';

function Header({ onMenuClick }) {
  const [anchorEl, setAnchorEl] = useState(null);
  const [notificationAnchor, setNotificationAnchor] = useState(null);
  const { preferences, setPreferences, alerts, metrics } = useStore();

  const handleProfileMenu = (event) => {
    setAnchorEl(event.currentTarget);
  };

  const handleNotificationMenu = (event) => {
    setNotificationAnchor(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
    setNotificationAnchor(null);
  };

  const toggleDarkMode = () => {
    setPreferences({ darkMode: !preferences.darkMode });
  };

  const unreadAlerts = alerts.filter(a => !a.read).length;

  return (
    <AppBar
      position="static"
      sx={{
        backgroundColor: 'background.paper',
        borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
        boxShadow: 'none',
      }}
    >
      <Toolbar>
        <IconButton
          edge="start"
          color="inherit"
          aria-label="menu"
          onClick={onMenuClick}
          sx={{ mr: 2, display: { sm: 'none' } }}
        >
          <MenuIcon />
        </IconButton>

        <Box sx={{ flexGrow: 1, display: 'flex', alignItems: 'center', gap: 3 }}>
          <TextField
            placeholder="Search domains, backends, or IPs..."
            size="small"
            sx={{
              width: 400,
              '& .MuiOutlinedInput-root': {
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
                '&:hover': {
                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                },
              },
            }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ color: 'text.secondary' }} />
                </InputAdornment>
              ),
            }}
          />

          <Box sx={{ display: 'flex', gap: 2 }}>
            <Chip
              icon={<SpeedIcon />}
              label={`${metrics.avgResponseTime.toFixed(0)}ms`}
              size="small"
              color="success"
              variant="outlined"
            />
            <Chip
              label={`${metrics.activeConnections} active`}
              size="small"
              color="primary"
              variant="outlined"
            />
            <Chip
              label={`${(metrics.errorRate * 100).toFixed(1)}% errors`}
              size="small"
              color={metrics.errorRate > 0.05 ? 'error' : 'success'}
              variant="outlined"
            />
          </Box>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <IconButton color="inherit" onClick={toggleDarkMode}>
            {preferences.darkMode ? <DarkModeIcon /> : <LightModeIcon />}
          </IconButton>

          <IconButton color="inherit" onClick={handleNotificationMenu}>
            <Badge badgeContent={unreadAlerts} color="error">
              <NotificationsIcon />
            </Badge>
          </IconButton>

          <IconButton onClick={handleProfileMenu}>
            <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main' }}>
              A
            </Avatar>
          </IconButton>
        </Box>

        {/* Profile Menu */}
        <Menu
          anchorEl={anchorEl}
          open={Boolean(anchorEl)}
          onClose={handleClose}
          PaperProps={{
            sx: {
              mt: 1.5,
              minWidth: 200,
              backgroundColor: 'background.paper',
              border: '1px solid rgba(255, 255, 255, 0.05)',
            },
          }}
        >
          <MenuItem onClick={handleClose}>
            <PersonIcon sx={{ mr: 1, fontSize: 20 }} />
            Profile
          </MenuItem>
          <MenuItem onClick={handleClose}>
            <SettingsIcon sx={{ mr: 1, fontSize: 20 }} />
            Settings
          </MenuItem>
          <MenuItem onClick={handleClose}>
            <LogoutIcon sx={{ mr: 1, fontSize: 20 }} />
            Logout
          </MenuItem>
        </Menu>

        {/* Notifications Menu */}
        <Menu
          anchorEl={notificationAnchor}
          open={Boolean(notificationAnchor)}
          onClose={handleClose}
          PaperProps={{
            sx: {
              mt: 1.5,
              minWidth: 350,
              maxHeight: 400,
              backgroundColor: 'background.paper',
              border: '1px solid rgba(255, 255, 255, 0.05)',
            },
          }}
        >
          <Box sx={{ p: 2, borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <Typography variant="h6">Notifications</Typography>
          </Box>
          {alerts.length === 0 ? (
            <Box sx={{ p: 3, textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                No notifications
              </Typography>
            </Box>
          ) : (
            alerts.slice(0, 5).map((alert, index) => (
              <MenuItem key={index} onClick={handleClose}>
                <Box>
                  <Typography variant="body2">{alert.message}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {alert.timestamp}
                  </Typography>
                </Box>
              </MenuItem>
            ))
          )}
        </Menu>
      </Toolbar>
    </AppBar>
  );
}

export default Header;