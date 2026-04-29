export enum AccountStatus {
   ACTIVE = 'ACTIVE',
   SUSPENDED = 'SUSPENDED',
   DELETED = 'DELETED',
   PENDING = 'PENDING',
}

export type WalletNetwork = 'stellar';

export interface WalletIdentity {
   address: string;
   network: WalletNetwork;
   isPrimary: boolean;
   verifiedAt?: Date;
}

export interface CreatorPerk {
   id: string;
   title: string;
   description: string;
   icon?: string;
}

export interface CreatorProfile {
   id: string;
   userId: string;
   handle: string;
   displayName: string;
   bio?: string;
   avatarUrl?: string;
   perkSummary?: string;
   perks?: CreatorPerk[];
   isVerified: boolean;
   createdAt: Date;
   updatedAt: Date;
}

export interface UserSettings {
   emailNotifications: boolean;
   productUpdates: boolean;
   marketingEmails: boolean;
   timezone?: string;
}

export interface User {
   id: string;
   email: string;
   emailVerified: boolean;
   firstName?: string;
   lastName?: string;
   avatarUrl?: string;
   status: AccountStatus;
   isAdmin: boolean;
   wallets: WalletIdentity[];
   creatorProfile?: CreatorProfile;
   settings: UserSettings;
   createdAt: Date;
   updatedAt: Date;
}

export interface RegisterUserDto {
   email: string;
   password: string;
   confirmPassword: string;
   firstName?: string;
   lastName?: string;
}

export interface LoginDto {
   email: string;
   password: string;
   rememberMe?: boolean;
}

export interface PublicUser {
   id: string;
   email: string;
   firstName?: string;
   lastName?: string;
   avatarUrl?: string;
   status: AccountStatus;
   isAdmin: boolean;
   creatorProfile?: Pick<
      CreatorProfile,
      'id' | 'handle' | 'displayName' | 'avatarUrl' | 'isVerified'
   >;
}

export interface LoginResponseDto {
   user: PublicUser;
   accessToken: string;
   refreshToken: string;
}

export interface CreateCreatorProfileDto {
   handle: string;
   displayName: string;
   bio?: string;
   avatarUrl?: string;
   perkSummary?: string;
   perks?: CreatorPerk[];
}

export interface UpdateCreatorProfileDto {
   displayName?: string;
   bio?: string;
   avatarUrl?: string;
   perkSummary?: string;
   perks?: CreatorPerk[];
}

export interface UpdateUserSettingsDto {
   emailNotifications?: boolean;
   productUpdates?: boolean;
   marketingEmails?: boolean;
   timezone?: string;
}

export interface CreatorMetrics {
   holderCount: number;
   totalSupply: number;
   totalVolume: number;
   lastActivityAt?: Date;
}

export interface UserCapabilities {
   canManageCreatorProfile: boolean;
   canAccessAdminTools: boolean;
   canLinkWallet: boolean;
}

export const STARTER_ACCOUNT_SCHEMA = `
model User {
  id             String          @id @default(cuid())
  email          String          @unique
  emailVerified  Boolean         @default(false)
  firstName      String?
  lastName       String?
  avatarUrl      String?
  status         AccountStatus   @default(PENDING)
  isAdmin        Boolean         @default(false)
  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt

  creatorProfile CreatorProfile?
  wallets        WalletIdentity[]
  settings       UserSettings?
}

model CreatorProfile {
  id          String   @id @default(cuid())
  userId      String   @unique
  handle      String   @unique
  displayName String
  bio         String?
  avatarUrl   String?
  perkSummary String?
  isVerified  Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

enum AccountStatus {
  ACTIVE
  SUSPENDED
  DELETED
  PENDING
}
`;

export function hasCreatorProfile(user: User): boolean {
   return user.creatorProfile !== undefined && user.creatorProfile !== null;
}

export function getUserCapabilities(user: User): UserCapabilities {
   return {
      canManageCreatorProfile: hasCreatorProfile(user),
      canAccessAdminTools: user.isAdmin,
      canLinkWallet: true,
   };
}

export function getUserDisplayName(user: User): string {
   const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
   return name || user.email;
}

export function getUserRoles(user: User): string[] {
   const roles: string[] = ['User'];
   if (hasCreatorProfile(user)) roles.push('Creator');
   if (user.isAdmin) roles.push('Admin');
   return roles;
}
