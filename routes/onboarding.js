import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import { onboardingStatus, dismissOnboarding, dismissAdminSetup } from '../lib/onboarding.js';

// The dashboard's "Get started" checklist (lib/onboarding.js). Web-app plumbing, not part of
// the external API, so it isn't under /api/v1.
const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await onboardingStatus(req.user.id));
  })
);

router.post(
  '/dismiss',
  asyncHandler(async (req, res) => {
    await dismissOnboarding(req.user.id);
    res.status(204).end();
  })
);

// The admins' "Finish setting up your server" card.
router.post(
  '/admin/dismiss',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await dismissAdminSetup(req.user.id);
    res.status(204).end();
  })
);

export default router;
