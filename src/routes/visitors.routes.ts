import { Router } from 'express';
import { listVisitors, logVisitor, approveVisitor, denyVisitor, logVisitorExit, getFlatContacts, approveByCall } from '../controllers/visitors.controller';
import { asyncSafe } from '../utils/asyncSafe';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/roleGuard';
import { wingGuard } from '../middleware/wingGuard';
import { handleSingleUpload } from '../middleware/upload.middleware';

const router = Router();
router.use(authenticate, wingGuard);

router.get('/', listVisitors);
router.post('/', requireRole('GUARD'), handleSingleUpload('photo'), logVisitor);
router.put('/:id/approve', requireRole('RESIDENT'), approveVisitor);
router.put('/:id/deny', requireRole('RESIDENT'), denyVisitor);
router.put('/:id/exit', requireRole('GUARD'), logVisitorExit);
router.get('/:id/contacts', requireRole('GUARD'), asyncSafe(getFlatContacts, 'flatContacts'));
router.put('/:id/approve-by-call', requireRole('GUARD'), asyncSafe(approveByCall, 'approveByCall'));

export default router;
