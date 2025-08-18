import React from 'react';
import { Box, Typography, Paper } from '@mui/material';

function Security() {
  return (
    <Box>
      <Typography variant="h4" sx={{ fontWeight: 700, mb: 3 }}>
        Security
      </Typography>
      <Paper sx={{ p: 3 }}>
        <Typography>Security dashboard coming soon...</Typography>
      </Paper>
    </Box>
  );
}

export default Security;