"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Eye, EyeOff, Lock, Mail, PenLine, ShieldX, User, UserRound } from "lucide-react";
import { PUBLIC_API_URL } from "@/lib/api-fetch";
import { authErrorMessage } from "@/lib/auth";

export default function RegisterForm() {
  const [registrationEnabled, setRegistrationEnabled] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    fetch(`${PUBLIC_API_URL}/settings`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法读取注册设置");
        const data = await response.json();
        setRegistrationEnabled(data.registrationEnabled === true);
      })
      .catch(() => setRegistrationEnabled(false));
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch(`${PUBLIC_API_URL}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: email.trim(),
          username: username.trim() || undefined,
          nickname: nickname.trim(),
          password,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (data.code === "REGISTER_DISABLED") setRegistrationEnabled(false);
        setError(authErrorMessage(data, "注册失败"));
        return;
      }
      setSubmitted(true);
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  if (registrationEnabled === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-adm-bg">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-adm-border border-t-adm-text" />
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-adm-bg px-4">
        <div className="w-full max-w-md rounded-2xl border border-adm-border bg-adm-card p-8 text-center shadow-sm">
          <CheckCircle2 className="mx-auto h-12 w-12 text-green-500" />
          <h1 className="mt-4 text-xl font-bold text-adm-text">注册申请已提交</h1>
          <p className="mt-2 text-sm leading-6 text-adm-text-secondary">
            账号需要管理员审核，审核通过后才能登录。请稍后返回登录页查看状态。
          </p>
          <Link href="/admin/login" className="mt-6 inline-flex rounded-xl bg-adm-primary px-5 py-2.5 text-sm font-medium text-adm-primary-text">
            返回登录
          </Link>
        </div>
      </div>
    );
  }

  if (!registrationEnabled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-adm-bg px-4">
        <div className="w-full max-w-md rounded-2xl border border-adm-border bg-adm-card p-8 text-center shadow-sm">
          <ShieldX className="mx-auto h-12 w-12 text-adm-text-tertiary" />
          <h1 className="mt-4 text-xl font-bold text-adm-text">注册暂未开放</h1>
          <p className="mt-2 text-sm text-adm-text-secondary">管理员当前关闭了新用户注册。</p>
          <div className="mt-6 flex justify-center gap-3">
            <Link href="/" className="rounded-xl border border-adm-border px-4 py-2 text-sm text-adm-text-secondary hover:bg-adm-card-hover">返回首页</Link>
            <Link href="/admin/login" className="rounded-xl bg-adm-primary px-4 py-2 text-sm font-medium text-adm-primary-text">已有账号登录</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-adm-bg px-4 py-10">
      <div className="mx-auto w-full max-w-md">
        <Link href="/" className="mb-5 inline-flex items-center gap-1.5 text-sm text-adm-text-secondary hover:text-adm-text">
          <ArrowLeft className="h-4 w-4" />
          返回首页
        </Link>
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-adm-primary shadow-xl">
            <PenLine className="h-7 w-7 text-adm-primary-text" />
          </div>
          <h1 className="text-xl font-bold text-adm-text">注册账号</h1>
          <p className="mt-1 text-sm text-adm-text-secondary">提交后需要管理员审核</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 rounded-2xl border border-adm-border bg-adm-card p-6 shadow-sm">
          {error ? <div className="rounded-lg bg-adm-danger-bg px-3 py-2 text-sm text-adm-danger">{error}</div> : null}
          <Field icon={<Mail className="h-4 w-4" />} label="邮箱">
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" className="field-input" placeholder="you@example.com" />
          </Field>
          <Field icon={<User className="h-4 w-4" />} label="用户名">
            <input type="text" value={username} onChange={(event) => setUsername(event.target.value)} required minLength={3} maxLength={50} pattern="[a-zA-Z0-9_]+" autoComplete="username" className="field-input" placeholder="仅字母、数字和下划线" />
          </Field>
          <Field icon={<UserRound className="h-4 w-4" />} label="昵称">
            <input type="text" value={nickname} onChange={(event) => setNickname(event.target.value)} required maxLength={100} className="field-input" placeholder="朋友圈显示名称" />
          </Field>
          <Field icon={<Lock className="h-4 w-4" />} label="密码">
            <div className="relative">
              <input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={6} autoComplete="new-password" className="field-input pr-10" placeholder="至少 6 位" />
              <button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-1/2 -translate-y-1/2 text-adm-text-tertiary hover:text-adm-text">
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </Field>
          <Field icon={<Lock className="h-4 w-4" />} label="确认密码">
            <input type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={6} autoComplete="new-password" className="field-input" placeholder="再次输入密码" />
          </Field>

          <button type="submit" disabled={submitting} className="w-full rounded-xl bg-adm-primary py-2.5 text-sm font-medium text-adm-primary-text transition-opacity hover:opacity-90 disabled:opacity-50">
            {submitting ? "提交中..." : "提交注册申请"}
          </button>
          <p className="text-center text-xs text-adm-text-tertiary">
            已有账号？<Link href="/admin/login" className="text-adm-text hover:underline">直接登录</Link>
          </p>
        </form>
      </div>
      <style jsx global>{`
        .field-input {
          width: 100%;
          border-radius: 0.75rem;
          border: 1px solid var(--adm-border);
          background: var(--adm-input);
          padding: 0.625rem 0.75rem;
          font-size: 0.875rem;
          color: var(--adm-text);
          outline: none;
        }
        .field-input:focus { border-color: var(--adm-text-secondary); }
      `}</style>
    </div>
  );
}

function Field({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-adm-text-secondary">{icon}{label}</span>
      {children}
    </label>
  );
}
