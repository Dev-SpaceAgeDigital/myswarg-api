import './config/env';
import { startReminderSchedule } from './services/reminders.service';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { prisma } from './config/db';
import redis from './config/redis';

import authRoutes from './routes/auth.routes';
import directoryRoutes from './routes/directory.routes';
import maintenanceRoutes from './routes/maintenance.routes';
import noticesRoutes from './routes/notices.routes';
import complaintsRoutes from './routes/complaints.routes';
import visitorsRoutes from './routes/visitors.routes';
import syncRoutes from './routes/sync.routes';
import superAdminRoutes from './routes/superadmin.routes';
import subAdminRoutes from './routes/subadmin.routes';
import subscriptionRoutes from './routes/subscription.routes';
import utilityRoutes from './routes/utility.routes';
import vaultRoutes from './routes/vault.routes';
import vendorRoutes from './routes/vendor.routes';
import domesticHelpRoutes from './routes/domesticHelp.routes';
import resaleListingRoutes from './routes/resaleListing.routes';
import guestInviteRoutes from './routes/guestInvite.routes';
import emergencyAlertRoutes from './routes/emergencyAlert.routes';
import amenityRoutes from './routes/amenity.routes';
import familyMemberRoutes from './routes/familyMember.routes';
import notificationsRoutes from './routes/notifications.routes';

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

// Railway sits behind a proxy; without this every client looks like the same
// IP and the login rate limiter would lock everyone out together.
app.set('trust proxy', 1);

console.log('All env vars:', {
  PORT: process.env.PORT,
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'NOT SET',
  REDIS_URL: process.env.REDIS_URL ? 'SET' : 'NOT SET',
});

// This must be the FIRST thing after const app = express();
app.use((req: any, res: any, next: any) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Step 3 — Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(helmet());
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Step 4 — Health check (no auth needed)
app.get('/', (_req: Request, res: Response) => res.json({ message: 'Nivasi API is running' }));
app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/api/health', (_req: Request, res: Response) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Step 5 — All routes
app.use('/api/auth', authRoutes);
app.use('/api/directory', directoryRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/notices', noticesRoutes);
app.use('/api/complaints', complaintsRoutes);
app.use('/api/visitors', visitorsRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/superadmin', superAdminRoutes);
app.use('/api/subadmin', subAdminRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/utilities', utilityRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/domestic-help', domesticHelpRoutes);
app.use('/api/resale-listings', resaleListingRoutes);
app.use('/api/guest-invites', guestInviteRoutes);
app.use('/api/emergency-alerts', emergencyAlertRoutes);
app.use('/api/amenities', amenityRoutes);
app.use('/api/family-members', familyMemberRoutes);
app.use('/api/notifications', notificationsRoutes);

app.use((_req: Request, res: Response) => res.status(404).json({ success: false, message: 'Route not found' }));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// Step 6 — Start server
const startServer = async () => {
  // Listen immediately so Railway's proxy can reach the server right away
  app.listen(PORT as any, '0.0.0.0', () => {
    if (process.env.NODE_ENV !== 'test') startReminderSchedule();
    console.log(`Server started on PORT ${PORT}`);
  });

  // DB connect in background — failure is logged but does not kill the server
  prisma.$connect()
    .then(() => console.log('[DB] Connected'))
    .catch((err: Error) => console.error('[DB] Connection failed:', err.message));

  // Redis non-fatal
  redis.on('error', () => {});
};

startServer();
