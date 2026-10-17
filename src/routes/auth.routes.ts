import { Router } from 'express';
import {
  handleGuardLogin,
  handleRefresh,
  handleLogout,
} from '../controllers/auth.controller';
import {
  handleCheckPhone,
  handleActivate,
  handlePinLogin,
  handleChangePin,
} from '../controllers/pin.controller';
import { authenticate } from '../middleware/auth.middleware';
import {
  checkPhoneLimiter, pinPhoneLimiter, pinIpLimiter,
  guardLoginLimiter, guardLoginIpLimiter,
} from '../middleware/rateLimit.middleware';
import { asyncSafe } from '../utils/asyncSafe';

const router = Router();

// Phone + PIN login. First-time users activate with the one-time code their
// Secretary gives them, and choose their own PIN there.
router.post('/check-phone', checkPhoneLimiter, asyncSafe(handleCheckPhone, 'checkPhone'));
router.post('/activate', pinIpLimiter, pinPhoneLimiter, asyncSafe(handleActivate, 'activate'));
router.post('/login-pin', pinIpLimiter, pinPhoneLimiter, asyncSafe(handlePinLogin, 'loginPin'));
router.post('/change-pin', authenticate, pinIpLimiter, asyncSafe(handleChangePin, 'changePin'));

router.post('/guard-login', guardLoginIpLimiter, guardLoginLimiter, asyncSafe(handleGuardLogin, 'guardLogin'));
router.post('/refresh', asyncSafe(handleRefresh, 'refresh'));
router.post('/logout', authenticate, asyncSafe(handleLogout, 'logout'));

export default router;
