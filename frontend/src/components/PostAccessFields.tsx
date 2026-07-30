"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Clock3, Search, Users } from "lucide-react";
import { PUBLIC_API_URL } from "@/lib/api-fetch";
import { toAbsoluteUrl } from "@/lib/upload";
import { toDateTimeLocal } from "@/lib/post-media";

export type PostVisibility = "public" | "authenticated" | "selected";

interface SelectableUser {
  id: string;
  nickname: string;
  username?: string;
  avatar?: string;
}

interface PostAccessFieldsProps {
  visibility: PostVisibility;
  onVisibilityChange: (value: PostVisibility) => void;
  visibleUserIds: string[];
  onVisibleUserIdsChange: (value: string[]) => void;
  publishedAt: string;
  onPublishedAtChange: (value: string) => void;
  externalMediaRisk: boolean;
  acknowledgeExternalMediaRisk: boolean;
  onAcknowledgeExternalMediaRiskChange: (value: boolean) => void;
  variant?: "wechat" | "admin";
  disabled?: boolean;
  visibilityDisabled?: boolean;
}

const VISIBILITY_OPTIONS: Array<{ value: PostVisibility; label: string; description: string }> = [
  { value: "authenticated", label: "登录用户", description: "仅审核通过并登录的用户可见" },
  { value: "public", label: "公开", description: "任何人和 RSS 均可见" },
  { value: "selected", label: "指定用户", description: "仅你选择的用户可见" },
];

export default function PostAccessFields({
  visibility,
  onVisibilityChange,
  visibleUserIds,
  onVisibleUserIdsChange,
  publishedAt,
  onPublishedAtChange,
  externalMediaRisk,
  acknowledgeExternalMediaRisk,
  onAcknowledgeExternalMediaRiskChange,
  variant = "wechat",
  disabled = false,
  visibilityDisabled = false,
}: PostAccessFieldsProps) {
  const [users, setUsers] = useState<SelectableUser[] | null>(null);
  const [userError, setUserError] = useState("");
  const [query, setQuery] = useState("");
  const loadingUsersRef = useRef(false);

  useEffect(() => {
    if (visibility !== "selected" || users !== null || loadingUsersRef.current) return;
    loadingUsersRef.current = true;
    fetch(`${PUBLIC_API_URL}/users/selectable`, { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法加载用户列表");
        const data = await response.json();
        setUserError("");
        setUsers(Array.isArray(data) ? data : []);
      })
      .catch((error) => setUserError(error instanceof Error ? error.message : "无法加载用户列表"))
      .finally(() => {
        loadingUsersRef.current = false;
      });
  }, [users, visibility]);

  const filteredUsers = useMemo(() => {
    const userList = users || [];
    const keyword = query.trim().toLowerCase();
    if (!keyword) return userList;
    return userList.filter((user) =>
      `${user.nickname} ${user.username || ""}`.toLowerCase().includes(keyword)
    );
  }, [query, users]);
  const loadingUsers = users === null && !userError;

  const panelClass = variant === "admin"
    ? "rounded-xl border border-adm-border bg-adm-card p-4"
    : "border-t border-black/5 py-3 dark:border-white/5";
  const mutedClass = variant === "admin" ? "text-adm-text-tertiary" : "text-wechat-time";
  const textClass = variant === "admin" ? "text-adm-text" : "text-wechat-text dark:text-gray-200";
  const inputClass = variant === "admin"
    ? "border-adm-border bg-adm-input text-adm-text placeholder:text-adm-text-tertiary"
    : "border-black/5 bg-wechat-bubble text-wechat-text placeholder:text-wechat-time dark:border-white/5 dark:bg-white/5 dark:text-gray-200";

  const toggleUser = (id: string) => {
    onVisibleUserIdsChange(
      visibleUserIds.includes(id)
        ? visibleUserIds.filter((userId) => userId !== id)
        : [...visibleUserIds, id]
    );
  };

  return (
    <div className={panelClass}>
      <div className="flex items-center gap-2">
        <Users className={`h-4 w-4 ${mutedClass}`} />
        <span className={`text-xs font-medium ${textClass}`}>谁可以看</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {VISIBILITY_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={disabled || visibilityDisabled}
            onClick={() => onVisibilityChange(option.value)}
            title={option.description}
            className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors disabled:opacity-50 ${
              visibility === option.value
                ? "border-green-500 bg-green-500 text-white"
                : `${inputClass} hover:border-green-400`
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className={`mt-1.5 text-[11px] ${mutedClass}`}>
        {VISIBILITY_OPTIONS.find((option) => option.value === visibility)?.description}
      </p>

      {visibility === "selected" && (
        <div className="mt-3 space-y-2">
          <div className="relative">
            <Search className={`absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 ${mutedClass}`} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索昵称或用户名"
              className={`w-full rounded-lg border py-2 pl-8 pr-3 text-xs outline-none focus:border-green-500 ${inputClass}`}
            />
          </div>
          <div className={`max-h-40 overflow-y-auto rounded-lg border ${inputClass}`}>
            {loadingUsers ? (
              <p className={`px-3 py-4 text-center text-xs ${mutedClass}`}>加载用户中...</p>
            ) : userError ? (
              <p className="px-3 py-4 text-center text-xs text-red-500">{userError}</p>
            ) : filteredUsers.length === 0 ? (
              <p className={`px-3 py-4 text-center text-xs ${mutedClass}`}>没有可选择的用户</p>
            ) : (
              filteredUsers.map((user) => {
                const selected = visibleUserIds.includes(user.id);
                return (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => toggleUser(user.id)}
                    className="flex w-full items-center gap-2 border-b border-black/5 px-3 py-2 text-left last:border-b-0 hover:bg-black/[0.03] dark:border-white/5 dark:hover:bg-white/5"
                  >
                    <div className="h-7 w-7 shrink-0 overflow-hidden rounded-md bg-black/5 dark:bg-white/5">
                      {user.avatar ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={toAbsoluteUrl(user.avatar)} alt="" className="h-full w-full object-cover" />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-xs font-medium ${textClass}`}>{user.nickname}</p>
                      {user.username ? <p className={`truncate text-[10px] ${mutedClass}`}>@{user.username}</p> : null}
                    </div>
                    <span className={`flex h-4 w-4 items-center justify-center rounded border ${selected ? "border-green-500 bg-green-500 text-white" : "border-black/20 dark:border-white/20"}`}>
                      {selected ? <Check className="h-3 w-3" /> : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <p className={`text-[11px] ${visibleUserIds.length > 0 ? mutedClass : "text-amber-600 dark:text-amber-400"}`}>
            已选择 {visibleUserIds.length} 人{visibleUserIds.length === 0 ? "，至少需要选择一人" : ""}
          </p>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Clock3 className={`h-4 w-4 shrink-0 ${mutedClass}`} />
        <div className="min-w-0 flex-1">
          <label className={`mb-1 block text-[11px] ${mutedClass}`}>发布时间（可选择现在或过去）</label>
          <input
            type="datetime-local"
            value={publishedAt}
            max={toDateTimeLocal()}
            onChange={(event) => onPublishedAtChange(event.target.value)}
            disabled={disabled}
            className={`w-full rounded-lg border px-3 py-2 text-xs outline-none focus:border-green-500 disabled:opacity-50 ${inputClass}`}
          />
        </div>
      </div>

      {externalMediaRisk && visibility !== "public" && (
        <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <input
            type="checkbox"
            checked={acknowledgeExternalMediaRisk}
            onChange={(event) => onAcknowledgeExternalMediaRiskChange(event.target.checked)}
            className="mt-0.5"
          />
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>内容包含外部图片、音视频或链接资源。本站无法阻止这些外部资源被直接访问，我已了解并仍要发布。</span>
        </label>
      )}
    </div>
  );
}
