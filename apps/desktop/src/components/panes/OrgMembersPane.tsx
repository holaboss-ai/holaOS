import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Check,
  ChevronDownFilled,
  Loader2,
  Send,
} from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { PageShell } from "@/components/ui/page-shell";
import {
  ASSIGNABLE_ROLES,
  type AssignableRole,
  type MutationResult,
  useOrgMembers,
} from "@/lib/auth/useOrgMembers";
import { orgLabel } from "@/lib/auth/useOrganizations";

// Native org member management (the "Members" org nav row). Reads the active
// org's member + invitation list and mutates it through the main-process
// Better-Auth org client over IPC — no embedded web page. Mirrors the web org
// panel: role-gated (admin+ can manage), never touch the owner or yourself.

function RolePicker({
  role,
  disabled,
  onChange,
}: {
  role: string;
  disabled?: boolean;
  onChange: (role: AssignableRole) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-foreground capitalize transition-colors hover:bg-foreground/6 disabled:opacity-60"
          >
            {role}
            <ChevronDownFilled className="size-3 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-28">
        {ASSIGNABLE_ROLES.map((option) => (
          <DropdownMenuItem
            key={option}
            onClick={() => onChange(option)}
            className="gap-2 capitalize"
          >
            <span className="flex-1">{option}</span>
            {option === role ? (
              <Check className="size-3.5 text-muted-foreground" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function OrgMembersPane() {
  const {
    activeOrg,
    members,
    invitations,
    userId,
    canManage,
    isPending,
    busy,
    invite,
    removeMember,
    updateRole,
    cancelInvite,
  } = useOrgMembers();

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AssignableRole>("member");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Runs a member mutation, surfaces its { ok, error } inline (the list refetches
  // on success via the hook's invalidation).
  const run = async (fn: () => Promise<MutationResult>): Promise<MutationResult> => {
    setError(null);
    const res = await fn().catch(
      (err): MutationResult => ({
        ok: false,
        error: err instanceof Error ? err.message : "Something went wrong.",
      }),
    );
    if (!res.ok) {
      setError(res.error ?? "Something went wrong.");
    }
    return res;
  };

  const handleInvite = async () => {
    const email = inviteEmail.trim();
    if (!email) {
      return;
    }
    const res = await run(() => invite(email, inviteRole));
    if (res.ok) {
      setInviteEmail("");
    }
  };

  return (
    <PageShell
      description={`Manage who belongs to ${orgLabel(activeOrg)}.`}
      title="Members"
    >
      <div className="grid gap-6">
        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <section className="grid gap-2">
          <h2 className="font-medium text-foreground text-sm">People</h2>
          {isPending ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </div>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {members.map((member) => {
                const isSelf = member.userId === userId;
                const isOwner = member.role === "owner";
                const email = member.user?.email ?? member.userId;
                const name = member.user?.name ?? email;
                const editable = canManage && !isSelf && !isOwner;
                return (
                  <li
                    key={member.id}
                    className="flex items-center justify-between gap-3 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-foreground text-sm">
                        {name}
                        {isSelf ? (
                          <span className="text-muted-foreground"> (you)</span>
                        ) : null}
                      </p>
                      <p className="truncate text-muted-foreground text-xs">
                        {email}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {editable ? (
                        <RolePicker
                          role={member.role}
                          disabled={busy}
                          onChange={(role) =>
                            void run(() => updateRole(member.id, role))
                          }
                        />
                      ) : (
                        <Badge variant="secondary" className="capitalize">
                          {member.role}
                        </Badge>
                      )}
                      {editable ? (
                        confirmRemove === member.id ? (
                          <span className="flex items-center gap-1">
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={busy}
                              onClick={() => {
                                setConfirmRemove(null);
                                void run(() => removeMember(member.id));
                              }}
                            >
                              Confirm
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => setConfirmRemove(null)}
                            >
                              Cancel
                            </Button>
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => setConfirmRemove(member.id)}
                          >
                            Remove
                          </Button>
                        )
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {canManage ? (
          <section className="grid gap-2">
            <h2 className="font-medium text-foreground text-sm">
              Invite a member
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="email"
                placeholder="name@company.com"
                className="h-8 w-64"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
              <RolePicker
                role={inviteRole}
                disabled={busy}
                onChange={setInviteRole}
              />
              <Button
                size="sm"
                disabled={busy || !inviteEmail.trim()}
                onClick={() => void handleInvite()}
              >
                <Send className="size-3.5" />
                Send invite
              </Button>
            </div>
            {invitations.length > 0 ? (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {invitations.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex items-center justify-between gap-3 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-foreground text-sm">
                        {inv.email}
                      </p>
                      <p className="text-muted-foreground text-xs capitalize">
                        {inv.role ?? "member"} · pending
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void run(() => cancelInvite(inv.id))}
                    >
                      Cancel
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>
    </PageShell>
  );
}
