// types/auth.types.ts - Add this to your backend types
import { Request, Response, NextFunction } from 'express';
import type { JwtPayload } from 'jsonwebtoken';

export type AdminTwoFactorStatus = 'pending_2fa' | 'verified';

export interface AdminJwtPayload extends JwtPayload {
   sub?: string;
   adminId?: string;
   role?: string;
   wallet?: string;
   twoFactorStatus?: string;
}

export interface GoogleCredentials {
   googleId: string;
   email: string;
   name: string;
   profilePicture?: string;
   emailVerified?: boolean;
}

export interface AdminUser {
   id: string;
   email: string;
   name: string;
   role: 'SYSTEM_ADMIN' | 'ADMIN';
   status: string;
   profilePicture?: string;
   lastLoginAt?: Date;
   createdAt: Date;
}

// Fixed LoginResult type to match your existing AuthService
export interface LoginResult {
   success: boolean;
   message?: string; // Made optional to match your AuthService
   admin: AdminUser | null;
   token: string;
}

// Type guard for successful login
export interface SuccessfulLoginResult {
   success: true;
   message?: string;
   admin: AdminUser; // Guaranteed to be present when success is true
   token: string;
}

export interface FailedLoginResult {
   success: false;
   message?: string;
   admin: null;
   token: string;
}

// Type guard function
export function isSuccessfulLogin(
   result: LoginResult
): result is SuccessfulLoginResult {
   return result.success && result.admin !== null;
}

export type AsyncController = (
   req: Request,
   res: Response,
   next: NextFunction
) => Promise<any>;
