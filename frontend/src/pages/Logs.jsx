import React from 'react';
import { Box, Typography, Paper } from '@mui/material';

function Logs() {
  return (
    <Box>
      <Typography variant="h4" sx={{ fontWeight: 700, mb: 3 }}>
        Logs
      </Typography>
      <Paper sx={{ p: 3 }}>
        <Typography>Log viewer coming soon...</Typography>
      </Paper>
    </Box>
  );
}

export default Logs;