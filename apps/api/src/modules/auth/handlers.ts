import type { Request, Response } from 'express';

import { AppError } from '../../lib/errors.js';

import * as service from './service.js';
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  ResendVerificationInput,
  ResetPasswordInput,
  SignOutEverywhereInput,
  SignupInput,
  UpdateProfileInput,
  VerifyEmailInput,
} from './schemas.js';

const callerCtx = (req: Request) => {
  const ua = req.get('user-agent');
  return {
    ...(typeof req.ip === 'string' ? { ipAddress: req.ip } : {}),
    ...(ua ? { userAgent: ua } : {}),
  };
};

export const signupHandler = async (req: Request, res: Response): Promise<void> => {
  const input = req.body as SignupInput;
  const result = await service.signup(input, callerCtx(req));
  res.status(201).json(result);
};

export const loginHandler = async (req: Request, res: Response): Promise<void> => {
  const input = req.body as LoginInput;
  const result = await service.login(input, callerCtx(req));
  res.status(200).json(result);
};

export const logoutHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = req.caller;
  if (!caller) throw new AppError('unauthorized', 401, 'auth required');
  await service.logout(caller.token.id, caller.user.id);
  res.status(204).end();
};

export const meHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = req.caller;
  if (!caller) throw new AppError('unauthorized', 401, 'auth required');
  const result = await service.me(caller.user.id);
  res.status(200).json(result);
};

export const updateProfileHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = req.caller;
  if (!caller) throw new AppError('unauthorized', 401, 'auth required');
  const result = await service.updateProfile(caller.user.id, req.body as UpdateProfileInput);
  res.status(200).json(result);
};

export const verifyEmailHandler = async (req: Request, res: Response): Promise<void> => {
  const result = await service.verifyEmail(req.body as VerifyEmailInput);
  res.status(200).json(result);
};

export const resendVerificationHandler = async (req: Request, res: Response): Promise<void> => {
  await service.resendVerification(req.body as ResendVerificationInput);
  res.status(204).end();
};

export const forgotPasswordHandler = async (req: Request, res: Response): Promise<void> => {
  await service.forgotPassword(req.body as ForgotPasswordInput);
  res.status(204).end();
};

export const resetPasswordHandler = async (req: Request, res: Response): Promise<void> => {
  const result = await service.resetPassword(req.body as ResetPasswordInput, callerCtx(req));
  res.status(200).json(result);
};

export const changePasswordHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = req.caller;
  if (!caller) throw new AppError('unauthorized', 401, 'auth required');
  await service.changePassword(caller.user.id, caller.token.id, req.body as ChangePasswordInput);
  res.status(204).end();
};

export const signOutEverywhereHandler = async (req: Request, res: Response): Promise<void> => {
  const caller = req.caller;
  if (!caller) throw new AppError('unauthorized', 401, 'auth required');
  await service.signOutEverywhere(
    caller.user.id,
    caller.token.id,
    req.body as SignOutEverywhereInput,
  );
  res.status(204).end();
};
