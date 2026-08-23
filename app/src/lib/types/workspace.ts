export type WorkspaceInvitation = {
  invitationId: string;
  email: string;
  workspaceRole: "workspace_owner" | "member";
  companySlug: string;
  companyRole: "owner" | "bookkeeper" | "reviewer" | "reader";
  expiresAt: string;
  status: "issued" | "delivery_confirmed" | "delivery_failed" | "accepted" | "cancelled";
  userId: string | null;
  createdAt: string;
};

export type WorkspaceInvitationInput = {
  email: string;
  workspaceRole: WorkspaceInvitation["workspaceRole"];
  companySlug: string;
  companyRole: WorkspaceInvitation["companyRole"];
};

export type WorkspaceInvitationClaim = {
  token: string;
  name: string;
  password: string;
};

export type WorkspaceMember = {
  userId: string;
  name: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  accessReady: boolean;
  workspaceRole: "workspace_owner" | "member";
  memberships: Array<{
    companySlug: string;
    companyName: string;
    role: WorkspaceInvitation["companyRole"];
    archived: boolean;
  }>;
};
