"use client";

import { useEffect, useState } from "react";
import { Loader2, PauseCircle, RotateCcw, Send, ShieldCheck, UserCheck, UserX } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { resolveAvatar } from "@/lib/avatar";

type AccountStatus = "pending" | "active" | "suspended" | "rejected";

interface ManagedUser {
  id: string;
  email: string;
  username: string;
  nickname: string;
  avatar: string;
  role: "admin" | "visitor";
  accountStatus: AccountStatus;
  canPublish: boolean;
  createdAt: string;
}

const STATUS_META: Record<AccountStatus, { label: string; className: string }> = {
  pending: { label: "待审核", className: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400" },
  active: { label: "正常", className: "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400" },
  suspended: { label: "已停用", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400" },
  rejected: { label: "已拒绝", className: "bg-gray-200 text-gray-600 dark:bg-white/10 dark:text-gray-400" },
};

export default function UserAccessManager() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState("");

  useEffect(() => {
    apiFetch("/admin/users")
      .then(async (response) => {
        if (!response.ok) throw new Error("用户列表加载失败");
        const data = await response.json();
        const priority: Record<AccountStatus, number> = { pending: 0, active: 1, suspended: 2, rejected: 3 };
        setUsers(Array.isArray(data)
          ? [...data].sort((a, b) => priority[a.accountStatus as AccountStatus] - priority[b.accountStatus as AccountStatus])
          : []);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "用户列表加载失败"))
      .finally(() => setLoading(false));
  }, []);

  const updateAccess = async (user: ManagedUser, patch: Partial<Pick<ManagedUser, "accountStatus" | "canPublish">>) => {
    const actionKey = `${user.id}:${Object.keys(patch).join("-")}`;
    setUpdating(actionKey);
    setError("");
    try {
      const response = await apiFetch(`/admin/users/${user.id}/access`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || "权限更新失败");
      setUsers((current) => current.map((item) => item.id === user.id ? { ...item, ...data } : item));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "权限更新失败");
    } finally {
      setUpdating("");
    }
  };

  const pendingCount = users.filter((user) => user.accountStatus === "pending").length;

  return (
    <section className="rounded-2xl border border-adm-border bg-adm-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-adm-text-tertiary" />
            <h3 className="text-sm font-semibold text-adm-text">用户审核与发布权限</h3>
          </div>
          <p className="mt-1 text-xs text-adm-text-tertiary">
            待审核 {pendingCount} 人，共 {users.length} 个账号。停用账号会立即失去私密内容访问权限。
          </p>
        </div>
      </div>

      {error ? <div className="mt-4 rounded-lg bg-adm-danger-bg px-3 py-2 text-sm text-adm-danger">{error}</div> : null}

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-adm-text-tertiary" /></div>
      ) : (
        <div className="mt-4 divide-y divide-adm-border overflow-hidden rounded-xl border border-adm-border">
          {users.map((user) => {
            const status = STATUS_META[user.accountStatus];
            const busy = updating.startsWith(user.id);
            return (
              <div key={user.id} className="flex flex-col gap-3 bg-adm-card px-4 py-3 sm:flex-row sm:items-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={resolveAvatar(user.avatar, user.email, 80)} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-adm-text">{user.nickname}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${status.className}`}>{status.label}</span>
                    {user.role === "admin" ? (
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-400">管理员</span>
                    ) : user.canPublish ? (
                      <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 dark:bg-purple-500/15 dark:text-purple-400">可发布</span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-adm-text-tertiary">
                    {user.username ? `@${user.username} · ` : ""}{user.email} · 注册于 {new Date(user.createdAt).toLocaleDateString("zh-CN")}
                  </p>
                </div>

                {user.role !== "admin" && (
                  <div className="flex flex-wrap gap-1.5 sm:justify-end">
                    {user.accountStatus === "pending" && (
                      <>
                        <ActionButton disabled={busy} onClick={() => updateAccess(user, { accountStatus: "active" })} icon={<UserCheck className="h-3.5 w-3.5" />} label="通过" />
                        <ActionButton danger disabled={busy} onClick={() => updateAccess(user, { accountStatus: "rejected", canPublish: false })} icon={<UserX className="h-3.5 w-3.5" />} label="拒绝" />
                      </>
                    )}
                    {user.accountStatus === "active" && (
                      <>
                        <ActionButton disabled={busy} onClick={() => updateAccess(user, { canPublish: !user.canPublish })} icon={user.canPublish ? <PauseCircle className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />} label={user.canPublish ? "收回发布" : "允许发布"} />
                        <ActionButton danger disabled={busy} onClick={() => updateAccess(user, { accountStatus: "suspended" })} icon={<PauseCircle className="h-3.5 w-3.5" />} label="停用" />
                      </>
                    )}
                    {(user.accountStatus === "suspended" || user.accountStatus === "rejected") && (
                      <ActionButton disabled={busy} onClick={() => updateAccess(user, { accountStatus: "active" })} icon={<RotateCcw className="h-3.5 w-3.5" />} label="恢复" />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ActionButton({ icon, label, onClick, disabled, danger = false }: { icon: React.ReactNode; label: string; onClick: () => void; disabled: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
        danger
          ? "border-red-200 text-red-600 hover:bg-red-50 dark:border-red-500/20 dark:text-red-400 dark:hover:bg-red-500/10"
          : "border-adm-border text-adm-text-secondary hover:bg-adm-card-hover hover:text-adm-text"
      }`}
    >
      {disabled ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {label}
    </button>
  );
}
