export interface Membership {
  organizationId: string;
  legalName: string;
  type: "INTERNAL" | "CLIENT" | "PARTNER";
  roleId: string;
  roleCode: string;
  roleName: string;
  permissions: string[];
  approvalLevel: number;
  isDefault: boolean;
}

export interface Me {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  locale: string | null;
  timezone: string | null;
  status: string;
  mfaEnabled: boolean;
  memberships: Membership[];
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult {
  mfaRequired?: false;
}

export interface MfaChallenge {
  mfaRequired: true;
  challengeId: string;
}
