import React from 'react';
import { Box, Typography, Paper } from '@mui/material';

function Monitoring() {
  return (
    <Box>
      <Typography variant="h4" sx={{ fontWeight: 700, mb: 3 }}>
        Monitoring
      </Typography>
      <Paper sx={{ p: 3 }}>
        <Typography>Monitoring dashboard coming soon...</Typography>
      </Paper>
    </Box>
  );
}

export default Monitoring;