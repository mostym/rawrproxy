import React from 'react';
import { Box, Typography, Paper } from '@mui/material';

function Traffic() {
  return (
    <Box>
      <Typography variant="h4" sx={{ fontWeight: 700, mb: 3 }}>
        Traffic Analytics
      </Typography>
      <Paper sx={{ p: 3 }}>
        <Typography>Real-time traffic analytics coming soon...</Typography>
      </Paper>
    </Box>
  );
}

export default Traffic;