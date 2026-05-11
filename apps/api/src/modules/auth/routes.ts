import { Router } from 'express';

import { asyncHandler } from '../../middleware/async-handler.js';
import { requireAuth } from '../../middleware/bearer-auth.js';
import { validate } from '../../middleware/validate.js';

import {
  changePasswordHandler,
  forgotPasswordHandler,
  loginHandler,
  logoutHandler,
  meHandler,
  resendVerificationHandler,
  resetPasswordHandler,
  signOutEverywhereHandler,
  signupHandler,
  updateProfileHandler,
  verifyEmailHandler,
} from './handlers.js';
import {
  changePasswordInput,
  forgotPasswordInput,
  loginInput,
  resendVerificationInput,
  resetPasswordInput,
  signOutEverywhereInput,
  signupInput,
  updateProfileInput,
  verifyEmailInput,
} from './schemas.js';

export const authRouter: Router = Router();

authRouter.post('/auth/signup', validate(signupInput, 'body'), asyncHandler(signupHandler));
authRouter.post('/auth/login', validate(loginInput, 'body'), asyncHandler(loginHandler));
authRouter.post('/auth/logout', requireAuth(), asyncHandler(logoutHandler));
authRouter.get('/auth/me', requireAuth(), asyncHandler(meHandler));
authRouter.patch(
  '/auth/me',
  requireAuth(),
  validate(updateProfileInput, 'body'),
  asyncHandler(updateProfileHandler),
);

authRouter.post(
  '/auth/email/verify',
  validate(verifyEmailInput, 'body'),
  asyncHandler(verifyEmailHandler),
);
authRouter.post(
  '/auth/email/resend-verification',
  validate(resendVerificationInput, 'body'),
  asyncHandler(resendVerificationHandler),
);

authRouter.post(
  '/auth/password/forgot',
  validate(forgotPasswordInput, 'body'),
  asyncHandler(forgotPasswordHandler),
);
authRouter.post(
  '/auth/password/reset',
  validate(resetPasswordInput, 'body'),
  asyncHandler(resetPasswordHandler),
);
authRouter.post(
  '/auth/password/change',
  requireAuth(),
  validate(changePasswordInput, 'body'),
  asyncHandler(changePasswordHandler),
);

authRouter.post(
  '/auth/sign-out-everywhere',
  requireAuth(),
  validate(signOutEverywhereInput, 'body'),
  asyncHandler(signOutEverywhereHandler),
);
