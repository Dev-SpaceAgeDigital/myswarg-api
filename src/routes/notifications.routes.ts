import { Router } from 'express';
import {
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  submitLeaveRequest,
  registerPushToken,
  clearPushToken,
} from '../controllers/notifications.controller';
import { authenticate } from '../middleware/auth.middleware';
import { asyncSafe } from '../utils/asyncSafe';

const router = Router();
router.use(authenticate);

router.get('/', listNotifications);
router.get('/unread-count', getUnreadCount);
router.post('/:id/read', markNotificationRead);
router.post('/read-all', markAllNotificationsRead);
router.post('/leave-request', submitLeaveRequest);
router.post('/push-token', asyncSafe(registerPushToken, 'registerPushToken'));
router.delete('/push-token', asyncSafe(clearPushToken, 'clearPushToken'));

export default router;
