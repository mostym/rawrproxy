import React from 'react';
import { Box, Typography, Paper } from '@mui/material';

function Configuration() {
  return (
    <Box>
      <Typography variant="h4" sx={{ fontWeight: 700, mb: 3 }}>
        Configuration
      </Typography>
      <Paper sx={{ p: 3 }}>
        <Typography>Configuration management coming soon...</Typography>
      </Paper>
    </Box>
  );
}

export default Configuration;