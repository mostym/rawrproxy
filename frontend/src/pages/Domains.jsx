import React, { useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Chip,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Switch,
  FormControlLabel,
  Tooltip,
  InputAdornment,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Security as SecurityIcon,
  Speed as SpeedIcon,
  CloudQueue as CloudIcon,
  CheckCircle as CheckIcon,
  Error as ErrorIcon,
  Search as SearchIcon,
  FilterList as FilterIcon,
  ContentCopy as CopyIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { motion } from 'framer-motion';
import { api } from '../services/api';

function DomainDialog({ open, onClose, domain }) {
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState({
    domain: domain?.domain || '',
    target: domain?.target || '',
    ssl_enabled: domain?.ssl_enabled || false,
    force_ssl: domain?.force_ssl || false,
    cache_enabled: domain?.cache_enabled || false,
    compression_enabled: domain?.compression_enabled || false,
    waf_enabled: domain?.waf_enabled || false,
    rate_limit: domain?.rate_limit || 100,
    active: domain?.active !== false,
  });

  const mutation = useMutation({
    mutationFn: domain
      ? () => api.updateDomain(domain.id, formData)
      : () => api.createDomain(formData),
    onSuccess: () => {
      queryClient.invalidateQueries(['domains']);
      toast.success(domain ? 'Domain updated successfully' : 'Domain created successfully');
      onClose();
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    mutation.mutate();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <form onSubmit={handleSubmit}>
        <DialogTitle>{domain ? 'Edit Domain' : 'Add New Domain'}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 2 }}>
            <TextField
              label="Domain"
              value={formData.domain}
              onChange={(e) => setFormData({ ...formData, domain: e.target.value })}
              placeholder="example.com"
              required
              fullWidth
            />
            <TextField
              label="Target Backend"
              value={formData.target}
              onChange={(e) => setFormData({ ...formData, target: e.target.value })}
              placeholder="http://192.168.1.100:8080"
              required
              fullWidth
            />
            <TextField
              label="Rate Limit"
              type="number"
              value={formData.rate_limit}
              onChange={(e) => setFormData({ ...formData, rate_limit: parseInt(e.target.value) })}
              InputProps={{
                endAdornment: <InputAdornment position="end">req/min</InputAdornment>,
              }}
              fullWidth
            />
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={formData.ssl_enabled}
                    onChange={(e) => setFormData({ ...formData, ssl_enabled: e.target.checked })}
                  />
                }
                label="SSL Enabled"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={formData.force_ssl}
                    onChange={(e) => setFormData({ ...formData, force_ssl: e.target.checked })}
                    disabled={!formData.ssl_enabled}
                  />
                }
                label="Force SSL"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={formData.cache_enabled}
                    onChange={(e) => setFormData({ ...formData, cache_enabled: e.target.checked })}
                  />
                }
                label="Enable Cache"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={formData.compression_enabled}
                    onChange={(e) => setFormData({ ...formData, compression_enabled: e.target.checked })}
                  />
                }
                label="Compression"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={formData.waf_enabled}
                    onChange={(e) => setFormData({ ...formData, waf_enabled: e.target.checked })}
                  />
                }
                label="WAF Protection"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={formData.active}
                    onChange={(e) => setFormData({ ...formData, active: e.target.checked })}
                  />
                }
                label="Active"
              />
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={mutation.isPending}>
            {domain ? 'Update' : 'Create'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function Domains() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedDomain, setSelectedDomain] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const queryClient = useQueryClient();

  const { data: domains = [], isLoading } = useQuery({
    queryKey: ['domains'],
    queryFn: api.getDomains,
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteDomain,
    onSuccess: () => {
      queryClient.invalidateQueries(['domains']);
      toast.success('Domain deleted successfully');
    },
  });

  const handleEdit = (domain) => {
    setSelectedDomain(domain);
    setDialogOpen(true);
  };

  const handleDelete = (id) => {
    if (confirm('Are you sure you want to delete this domain?')) {
      deleteMutation.mutate(id);
    }
  };

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  const filteredDomains = domains.filter((domain) =>
    domain.domain.toLowerCase().includes(searchTerm.toLowerCase()) ||
    domain.target.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <Box>
      <Box sx={{ mb: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Domains
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Manage domain routing and configuration
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => {
            setSelectedDomain(null);
            setDialogOpen(true);
          }}
        >
          Add Domain
        </Button>
      </Box>

      <Paper sx={{ mb: 3, p: 2 }}>
        <TextField
          placeholder="Search domains..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          fullWidth
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
          }}
        />
      </Paper>

      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Domain</TableCell>
              <TableCell>Target</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>SSL</TableCell>
              <TableCell>Features</TableCell>
              <TableCell>Rate Limit</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filteredDomains.map((domain) => (
              <motion.tr
                key={domain.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                component={TableRow}
              >
                <TableCell>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {domain.domain}
                    </Typography>
                    <IconButton size="small" onClick={() => handleCopy(domain.domain)}>
                      <CopyIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Box>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                    {domain.target}
                  </Typography>
                </TableCell>
                <TableCell>
                  {domain.active ? (
                    <Chip
                      icon={<CheckIcon />}
                      label="Active"
                      color="success"
                      size="small"
                    />
                  ) : (
                    <Chip
                      icon={<ErrorIcon />}
                      label="Inactive"
                      color="error"
                      size="small"
                    />
                  )}
                </TableCell>
                <TableCell>
                  {domain.ssl_enabled ? (
                    <Chip
                      icon={<SecurityIcon />}
                      label={domain.force_ssl ? 'Forced' : 'Enabled'}
                      color="primary"
                      size="small"
                    />
                  ) : (
                    <Chip label="Disabled" size="small" variant="outlined" />
                  )}
                </TableCell>
                <TableCell>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                    {domain.cache_enabled && (
                      <Tooltip title="Caching enabled">
                        <Chip icon={<SpeedIcon />} label="Cache" size="small" />
                      </Tooltip>
                    )}
                    {domain.waf_enabled && (
                      <Tooltip title="WAF protection enabled">
                        <Chip icon={<SecurityIcon />} label="WAF" size="small" color="warning" />
                      </Tooltip>
                    )}
                    {domain.compression_enabled && (
                      <Tooltip title="Compression enabled">
                        <Chip icon={<CloudIcon />} label="Gzip" size="small" />
                      </Tooltip>
                    )}
                  </Box>
                </TableCell>
                <TableCell>
                  <Typography variant="body2">
                    {domain.rate_limit} req/min
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  <IconButton size="small" onClick={() => handleEdit(domain)}>
                    <EditIcon />
                  </IconButton>
                  <IconButton
                    size="small"
                    onClick={() => handleDelete(domain.id)}
                    color="error"
                  >
                    <DeleteIcon />
                  </IconButton>
                </TableCell>
              </motion.tr>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <DomainDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        domain={selectedDomain}
      />
    </Box>
  );
}

export default Domains;