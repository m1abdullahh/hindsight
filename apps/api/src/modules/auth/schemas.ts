import { z } from 'zod';

export const Email = z.string().trim().toLowerCase().email();
const Password = z.string().min(12).max(128);
const Name = z.string().trim().min(1).max(100);
const OrgName = z.string().trim().min(1).max(100);
const Token = z.string().min(20).max(200);

export const signupInput = z.object({
  email: Email,
  password: Password,
  name: Name,
  organizationName: OrgName,
});
export type SignupInput = z.infer<typeof signupInput>;

export const loginInput = z.object({
  email: Email,
  password: Password,
});
export type LoginInput = z.infer<typeof loginInput>;

export const verifyEmailInput = z.object({ token: Token });
export type VerifyEmailInput = z.infer<typeof verifyEmailInput>;

export const resendVerificationInput = z.object({ email: Email });
export type ResendVerificationInput = z.infer<typeof resendVerificationInput>;

export const forgotPasswordInput = z.object({ email: Email });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordInput>;

export const resetPasswordInput = z.object({ token: Token, password: Password });
export type ResetPasswordInput = z.infer<typeof resetPasswordInput>;

export const changePasswordInput = z.object({
  currentPassword: Password,
  newPassword: Password,
});
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;

export const signOutEverywhereInput = z.object({
  keepCurrent: z.boolean().default(true),
});
export type SignOutEverywhereInput = z.infer<typeof signOutEverywhereInput>;

export const updateProfileInput = z
  .object({
    name: Name.optional(),
  })
  .refine((v) => v.name !== undefined, {
    message: 'must include at least one field',
  });
export type UpdateProfileInput = z.infer<typeof updateProfileInput>;
