import { Router } from 'express';
import {
  listFlats,
  getFlatDetail,
  createFlat,
  updateFlat,
  addResident,
  removeResident,
  updateResident,
  addVehicle,
  deleteVehicle,
  getGuards,
  addGuard,
  updateGuardPin,
  addStaff,
  getSecretaryProfile,
  updateSecretaryUpi,
  resetResidentPin,
} from '../controllers/directory.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/roleGuard';
import { wingGuard } from '../middleware/wingGuard';
import { asyncSafe } from '../utils/asyncSafe';

const router = Router();
router.use(authenticate, wingGuard);

router.get('/flats', listFlats);
router.get('/flats/:id', getFlatDetail);
router.post('/flats', requireRole('WING_ADMIN'), createFlat);
router.put('/flats/:id', requireRole('WING_ADMIN'), updateFlat);
router.post('/residents', requireRole('WING_ADMIN'), addResident);
router.delete('/residents/:id', requireRole('WING_ADMIN'), removeResident);
router.put('/residents/:userId', requireRole('WING_ADMIN'), updateResident);
router.post('/vehicles', requireRole('WING_ADMIN'), addVehicle);
router.delete('/vehicles/:id', requireRole('WING_ADMIN'), deleteVehicle);
router.get('/guards', requireRole('WING_ADMIN'), getGuards);
router.post('/guards', requireRole('WING_ADMIN'), addGuard);
router.put('/guards/:guardId/pin', requireRole('WING_ADMIN'), updateGuardPin);
router.post('/staff', requireRole('WING_ADMIN'), addStaff);
router.get('/secretary/upi', requireRole('WING_ADMIN'), getSecretaryProfile);
router.post('/residents/:userId/reset-pin', requireRole('WING_ADMIN'), asyncSafe(resetResidentPin, 'resetResidentPin'));
router.put('/secretary/upi', requireRole('WING_ADMIN'), updateSecretaryUpi);

export default router;
