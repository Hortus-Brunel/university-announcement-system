require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const logger = require('./config/logger');
const errorHandler = require('./middlewares/errorHandler');
const { purgeExpiredAnnouncements } = require('./services/announcementService');

// Route imports
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const announcementRoutes = require('./routes/announcementRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const organizationRoutes = require('./routes/organizationRoutes');
const uploadRoutes = require('./routes/uploadRoutes');

const app = express();

// ─── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());

const configuredOrigins = [
  process.env.CLIENT_ORIGIN,
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5000'
].filter(Boolean).map(url => url.replace(/\/$/, ''));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const sanitized = origin.replace(/\/$/, '');
    if (configuredOrigins.includes(sanitized)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS policy blocked request from ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ─── HTTP Request logging (Morgan → Winston) ──────────────────────────────────
app.use(
  morgan('combined', {
    stream: { write: (message) => logger.http(message.trim()) },
    skip: (req) => req.url === '/api/health',
  })
);

// ─── Static uploads directory (local storage fallback) ───────────────────────
app.use('/uploads', (req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
}, express.static(path.join(__dirname, 'uploads')));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
// Strict limit on auth endpoints to prevent brute-force attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests from this IP, please try again after 15 minutes.', errors: [] },
});

// Global API rate limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.', errors: [] },
});

app.use('/api/', apiLimiter);
app.use('/api/auth', authLimiter);

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/organization', organizationRoutes);
app.use('/api/upload', uploadRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'UAIMS API is running.', data: { version: '1.0.0', env: process.env.NODE_ENV } });
});

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found.', errors: [] });
});

// ─── Global error handler (MUST be last) ─────────────────────────────────────
app.use(errorHandler);

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  logger.info(`UAIMS API running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode.`);
});

// ─── Daily expiry purge scheduler ────────────────────────────────────────────
// Runs immediately on startup to clear any already-expired announcements,
// then fires every night at midnight. Hard-deletes expired rows + all their
// cascade data (targets, attachments, bookmarks, notifications, reactions,
// comments) so they no longer occupy space in the database.
function scheduleMidnightPurge() {
  const now = new Date();
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1, // next calendar day
    0, 0, 0, 0         // 00:00:00.000
  );
  const msUntilMidnight = midnight - now;

  setTimeout(() => {
    purgeExpiredAnnouncements().catch((err) =>
      logger.error('[Purge] Scheduled purge failed: %s', err.message)
    );
    // Re-schedule every 24 hours after the first midnight run
    setInterval(() => {
      purgeExpiredAnnouncements().catch((err) =>
        logger.error('[Purge] Scheduled purge failed: %s', err.message)
      );
    }, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  logger.info(
    `[Purge] Expiry purge scheduled. Next run at midnight (in ~${Math.round(msUntilMidnight / 60000)} min).`
  );
}

// Run once immediately on startup, then schedule nightly
purgeExpiredAnnouncements()
  .then(() => scheduleMidnightPurge())
  .catch((err) => logger.error('[Purge] Startup purge failed: %s', err.message));

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed.');
    process.exit(0);
  });
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled promise rejection: %s', err.message);
  server.close(() => process.exit(1));
});

module.exports = app;
