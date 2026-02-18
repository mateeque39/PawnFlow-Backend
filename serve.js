const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const buildPath = path.join(__dirname, 'build');

// Check if build folder exists
if (!fs.existsSync(buildPath)) {
  console.error(`❌ Build folder not found at: ${buildPath}`);
  process.exit(1);
}

// Serve static files from the build directory with caching
app.use(express.static(buildPath, {
  maxAge: 0,  // Don't cache - always check for updates
  etag: true  // Use etag to detect changes
}));

// Middleware to log requests
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Handle SPA routing - serve index.html for all routes
app.get('*', (req, res) => {
  const indexPath = path.join(buildPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    console.error(`❌ index.html not found at: ${indexPath}`);
    res.status(404).send('index.html not found');
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error(`❌ Error:`, err);
  res.status(500).send('Internal server error');
});

app.listen(PORT, () => {
  console.log(`🚀 Frontend server running on port ${PORT}`);
  console.log(`📁 Serving static files from: ${buildPath}`);
});
